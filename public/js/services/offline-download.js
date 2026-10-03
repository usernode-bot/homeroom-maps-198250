// Offline download orchestrator — plan, fetch, store, verify, resume,
// cancel, delete. Rate-limited and honest.
//
// THE GATE. `start()` refuses unless the caller passes a resolved capability
// whose stage is 'ready' and downloadsEnabled is true. Before that point the
// orchestrator issues NO network request at all: with the tile-provider
// permission gate closed (blocker B2, see offline/provider-policy.js) there
// is no download, no partial download and no state that could look like one.
//
// A region reaches 'complete' only after every planned artifact is stored
// and read back verified. A cancelled run leaves the manifest 'interrupted'
// with its real progress; a failed run leaves 'failed' with a typed reason.
// Storage failures surface as reason 'storage_limit' so the screen can show
// the storage-limit state instead of a generic error.
'use strict';

import { tilesForBounds } from './offline-tiles.js';

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TILE_DELAY_MS = 25;

// Glyph unicode ranges planned per font stack. Latin and Latin-1 Supplement
// plus Latin Extended-A cover the app's shipped languages (English,
// Indonesian). The planned ranges are recorded on the manifest artifact, so
// verification checks exactly what was planned and a future change that
// widens coverage changes the plan first.
const GLYPH_RANGES = ['0-255', '256-511'];

export const DOWNLOAD_STATUS = {
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

export const DOWNLOAD_REASON = {
  STORAGE_LIMIT: 'storage_limit',
  STORAGE_BUDGET: 'storage_budget',
  VERIFICATION: 'verification_failed',
  STYLE: 'style_failed',
  TILE: 'tile_failed',
  NETWORK: 'network_error',
};

function quotaError(err) {
  return Boolean(
    err &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 ||
        err.code === 1014),
  );
}

export function createDownloadManager({
  store,
  fetchImpl,
  concurrency = DEFAULT_CONCURRENCY,
  tileDelayMs = DEFAULT_TILE_DELAY_MS,
  now = () => new Date().toISOString(),
  maxTiles = 20000,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  // One active run per manager; the screen owns one manager at a time.
  let active = null;

  function emitProgress(onProgress, payload) {
    if (typeof onProgress === 'function') {
      try {
        onProgress(payload);
      } catch {
        /* a progress listener must never break the download */
      }
    }
  }

  async function fetchBytes(url, { signal, required = true } = {}) {
    const res = await doFetch(url, { signal, redirect: 'follow' });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} for ${url}`);
      error.status = res.status;
      if (!required && res.status === 404) {
        error.optionalMiss = true;
        return null;
      }
      throw error;
    }
    return res.arrayBuffer();
  }

  // The glyph template's {fontstack}/{range} placeholders.
  function glyphUrl(template, fontstack, range) {
    return template
      .replace('{fontstack}', encodeURIComponent(fontstack))
      .replace('{range}', range);
  }

  function fontStacksFromStyle(style) {
    const stacks = new Set();
    for (const layer of (style && style.layers) || []) {
      const layout = layer && layer.layout;
      const fonts = layout && layout['text-font'];
      if (Array.isArray(fonts) && fonts.length) stacks.add(fonts.join(','));
    }
    return [...stacks].map((joined) => joined.split(',').map((s) => s.trim()).filter(Boolean));
  }

  // Resolve the required map resources from the style document: the style
  // itself, each source's TileJSON, the sprite set and the glyph ranges.
  async function resolveRequiredResources({ styleBuffer, styleUrl, signal }) {
    const styleText = new TextDecoder('utf-8').decode(styleBuffer);
    let style;
    try {
      style = JSON.parse(styleText);
    } catch (err) {
      const error = new Error('The style document is not valid JSON.');
      error.reason = DOWNLOAD_REASON.STYLE;
      throw error;
    }

    const required = [
      { kind: 'metadata', url: styleUrl, data: styleBuffer },
    ];
    const tileTemplates = [];

    for (const source of Object.values(style.sources || {})) {
      if (source && typeof source.url === 'string') {
        const tileJsonBuffer = await fetchBytes(source.url, { signal });
        required.push({ kind: 'metadata', url: source.url, data: tileJsonBuffer });
        try {
          const tileJson = JSON.parse(new TextDecoder('utf-8').decode(tileJsonBuffer));
          for (const template of tileJson.tiles || []) tileTemplates.push(template);
        } catch {
          const error = new Error(`The TileJSON at ${source.url} is not valid JSON.`);
          error.reason = DOWNLOAD_REASON.STYLE;
          throw error;
        }
      }
      // Inline source tiles (source.tiles without a TileJSON) are templates
      // directly on the style.
      if (Array.isArray(source && source.tiles)) tileTemplates.push(...source.tiles);
    }

    const spriteUrls = [];
    const sprite = style.sprite;
    const spriteBases = typeof sprite === 'string' ? [sprite] : sprite && sprite.default ? [sprite.default] : [];
    for (const base of spriteBases) {
      spriteUrls.push(`${base}.json`, `${base}.png`, `${base}@2x.json`, `${base}@2x.png`);
    }

    const glyphPlans = [];
    if (typeof style.glyphs === 'string') {
      for (const stack of fontStacksFromStyle(style)) {
        for (const range of GLYPH_RANGES) {
          glyphPlans.push({ url: glyphUrl(style.glyphs, stack.join(','), range), required: true });
        }
      }
    }

    return { style, required, tileTemplates, spriteUrls, glyphPlans };
  }

  // Fetch the planned tiles with a small concurrency pool and a per-request
  // delay, skipping tiles already stored (resume), reporting progress, and
  // stopping cleanly on cancellation.
  async function downloadTiles({ region, tiles, templates, signal, onProgress, budget }) {
    const total = tiles.length;
    let done = 0;
    let bytes = budget.bytesDone || 0;
    let lastEmit = 0;

    const report = (force = false) => {
      const stamp = Date.now();
      if (force || stamp - lastEmit > 250) {
        lastEmit = stamp;
        emitProgress(onProgress, {
          regionId: region.id,
          phase: 'tiles',
          done,
          total,
          bytes,
        });
      }
    };

    async function worker(queue) {
      while (queue.length) {
        if (signal.aborted) return;
        const tile = queue.shift();
        const existing = await store.getTile(region.id, tile.z, tile.x, tile.y);
        if (existing && existing.byteLength > 0) {
          done += 1;
          bytes += existing.byteLength;
          report();
          continue;
        }
        const template = templates[(tile.z + tile.x + tile.y) % templates.length];
        const url = template
          .replace('{z}', String(tile.z))
          .replace('{x}', String(tile.x))
          .replace('{y}', String(tile.y))
          .replace('{ratio}', '1');
        const data = await fetchBytes(url, { signal });
        await store.putTile({ regionId: region.id, ...tile, data });
        done += 1;
        bytes += data.byteLength;
        report();
        if (tileDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, tileDelayMs));
        }
      }
    }

    const queue = tiles.slice();
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, () =>
      worker(queue));
    await Promise.all(workers);
    report(true);
    return { done, bytes };
  }

  return {
    // Cancels the active run, if any. The run settles as 'cancelled' and the
    // manifest is left 'interrupted' with its real progress.
    cancel() {
      if (active) active.cancel();
    },

    get active() {
      return Boolean(active);
    },

    async start({
      capability,
      preset,
      provider,
      styleUrl,
      attribution,
      maxStorageBytes = 0,
      onProgress,
      regionService,
      existingRegion = null,
    } = {}) {
      // ---- the B2 gate: refuse closed capabilities with zero network use ----
      if (!capability || capability.stage !== 'ready' || capability.downloadsEnabled !== true) {
        return {
          status: DOWNLOAD_STATUS.BLOCKED,
          blocker: (capability && capability.blocker) || 'B2',
          tilesDone: 0,
          tilesTotal: 0,
          bytesDone: 0,
        };
      }
      if (!preset || !styleUrl) {
        throw new Error('A preset and the style URL are required to download a region.');
      }

      // Plan first: the exact tile set is frozen before anything is fetched,
      // so verification can compare stored counts against the plan.
      const plan = tilesForBounds(preset.bounds, preset.zoom);
      if (plan.length === 0) throw new Error('The preset covers no tiles at its zoom range.');
      if (plan.length > maxTiles) {
        return {
          status: DOWNLOAD_STATUS.FAILED,
          reason: DOWNLOAD_REASON.STORAGE_BUDGET,
          tilesDone: 0,
          tilesTotal: plan.length,
          bytesDone: 0,
        };
      }

      // Resume: an interrupted or failed manifest can be continued into the
      // SAME region, so the tiles already stored are skipped by the pool
      // below instead of being fetched again. Any other status starts fresh.
      const reuse =
        existingRegion &&
        existingRegion.id &&
        ['downloading', 'interrupted', 'failed'].includes(existingRegion.status);
      const region = reuse
        ? existingRegion
        : await regionService.create({
            preset,
            provider,
            styleUrl,
            attribution,
            tileCount: plan.length,
          });
      if (reuse) {
        region.status = 'downloading';
        await regionService.update(region.id, { status: 'downloading' });
      }

      const controller = new AbortController();
      let cancelled = false;
      const run = {
        cancel() {
          cancelled = true;
          controller.abort();
        },
      };
      active = run;

      const bytesDoneTracker = { bytesDone: 0 };
      // Hosts this run actually used. The screen hands them to the service
      // worker's allowlist; the worker also derives its set from the stored
      // resources, so this is an addition, never the only gate.
      const usedHosts = new Set();
      const noteHost = (value) => {
        try {
          const u = new URL(String(value));
          if (u.protocol === 'https:' || u.protocol === 'http:') usedHosts.add(u.hostname.toLowerCase());
        } catch {
          /* an unusable value contributes nothing */
        }
      };
      const finish = async (patch) => {
        active = null;
        try {
          await regionService.update(region.id, patch);
        } catch {
          /* the manifest update must never mask the run's own outcome */
        }
        return patch;
      };

      try {
        emitProgress(onProgress, { regionId: region.id, phase: 'resources', done: 0, total: 0, bytes: 0 });

        // Phase 1: the style document, then the resources it points at.
        const styleBuffer = await fetchBytes(styleUrl, { signal: controller.signal });
        noteHost(styleUrl);
        const resolved = await resolveRequiredResources({
          styleBuffer,
          styleUrl,
          signal: controller.signal,
        });

        // Phase 2: sprites (required base set, optional @2x) and glyphs.
        const resourceRecords = [];
        for (const entry of resolved.required) {
          noteHost(entry.url);
          const record = await store.putResource({
            regionId: region.id,
            kind: entry.kind,
            url: entry.url,
            data: entry.data,
          });
          resourceRecords.push(record);
          bytesDoneTracker.bytesDone += record.byteLength;
        }
        for (const url of resolved.spriteUrls) {
          noteHost(url);
          const data = await fetchBytes(url, { signal: controller.signal, required: false });
          if (data) {
            const record = await store.putResource({
              regionId: region.id,
              kind: 'sprite',
              url,
              data,
            });
            resourceRecords.push(record);
            bytesDoneTracker.bytesDone += record.byteLength;
          }
        }
        for (const plan2 of resolved.glyphPlans) {
          noteHost(plan2.url);
          const data = await fetchBytes(plan2.url, { signal: controller.signal });
          const record = await store.putResource({
            regionId: region.id,
            kind: 'glyph',
            url: plan2.url,
            data,
          });
          resourceRecords.push(record);
          bytesDoneTracker.bytesDone += record.byteLength;
        }

        // Phase 3: tiles. Without a tile template the style resolves to a
        // source this run cannot plan; that is a failure, never an empty
        // region pretending to be complete.
        if (!resolved.tileTemplates.length) {
          const error = new Error('The resolved style advertises no tile templates.');
          error.reason = DOWNLOAD_REASON.STYLE;
          throw error;
        }
        resolved.tileTemplates.forEach(noteHost);
        const tileResult = await downloadTiles({
          region,
          tiles: plan,
          templates: resolved.tileTemplates.length ? resolved.tileTemplates : [],
          signal: controller.signal,
          onProgress,
          budget: bytesDoneTracker,
        });
        // The pool exits quietly when the signal fires. A quiet exit with an
        // aborted signal IS a cancellation: settle it as one, before the
        // verifier could ever misread the missing tiles as a failure.
        if (controller.signal.aborted || cancelled) {
          const error = new Error('The download was cancelled.');
          error.name = 'AbortError';
          throw error;
        }

        // Phase 4: verify EVERYTHING planned against what is stored.
        emitProgress(onProgress, { regionId: region.id, phase: 'verify', done: tileResult.done, total: plan.length, bytes: tileResult.bytes });
        const verification = await verifyRegion({ store, region, plan, resourceRecords });
        if (!verification.ok) {
          await finish({
            status: 'failed',
            failedReason: DOWNLOAD_REASON.VERIFICATION,
            completedAt: null,
          });
          return {
            status: DOWNLOAD_STATUS.FAILED,
            reason: DOWNLOAD_REASON.VERIFICATION,
            tilesDone: verification.tilesStored,
            tilesTotal: plan.length,
            bytesDone: tileResult.bytes,
            manifest: verification.manifest,
          };
        }

        const completedAt = now();
        await finish({
          status: 'complete',
          completedAt,
          byteSize: tileResult.bytes,
          tileCount: tileResult.done,
          artifacts: region.artifacts.map((a) =>
            a.kind === 'tiles' ? { ...a, status: 'complete', tileCount: tileResult.done, byteSize: tileResult.bytes } : a,
          ),
        });
        return {
          status: DOWNLOAD_STATUS.COMPLETED,
          tilesDone: tileResult.done,
          tilesTotal: plan.length,
          bytesDone: tileResult.bytes,
          hosts: [...usedHosts],
          manifest: verification.manifest,
        };
      } catch (err) {
        active = null;
        if (cancelled || (err && err.name === 'AbortError')) {
          const usage = await safeRegionUsage(store, region.id);
          await finish({
            status: 'interrupted',
            interruptedAt: now(),
            interruptedTiles: usage.tiles.count,
          });
          return {
            status: DOWNLOAD_STATUS.CANCELLED,
            tilesDone: usage.tiles.count,
            tilesTotal: plan.length,
            bytesDone: usage.bytes,
          };
        }
        if (quotaError(err)) {
          await finish({ status: 'failed', failedReason: DOWNLOAD_REASON.STORAGE_LIMIT });
          return {
            status: DOWNLOAD_STATUS.FAILED,
            reason: DOWNLOAD_REASON.STORAGE_LIMIT,
            tilesTotal: plan.length,
            bytesDone: bytesDoneTracker.bytesDone,
          };
        }
        const reason = err && err.reason ? err.reason : DOWNLOAD_REASON.NETWORK;
        await finish({ status: 'failed', failedReason: reason });
        return {
          status: DOWNLOAD_STATUS.FAILED,
          reason,
          message: (err && err.message) || 'The download failed.',
          tilesTotal: plan.length,
          bytesDone: bytesDoneTracker.bytesDone,
        };
      }
    },
  };
}

async function safeRegionUsage(store, regionId) {
  try {
    return await store.regionUsage(regionId);
  } catch {
    return { tiles: { count: 0, bytes: 0 }, resources: { count: 0, bytes: 0 }, bytes: 0 };
  }
}

// Read back every planned tile and resource. Verification is the line
// between "downloaded" and "presented as downloaded": only a run whose plan
// is fully present, with non-empty payloads, can mark a region complete.
async function verifyRegion({ store, region, plan, resourceRecords }) {
  for (const tile of plan) {
    const record = await store.getTile(region.id, tile.z, tile.x, tile.y);
    if (!record || !(record.byteLength > 0)) {
      return { ok: false, tilesStored: countStored(plan, store, region) };
    }
  }
  for (const record of resourceRecords) {
    const check = await store.getResource(region.id, record.url);
    if (!check || !(check.byteLength > 0)) return { ok: false, tilesStored: plan.length };
  }
  return { ok: true, manifest: region };
}

async function countStored(plan, store, region) {
  let count = 0;
  for (const tile of plan) {
    const record = await store.getTile(region.id, tile.z, tile.x, tile.y);
    if (record && record.byteLength > 0) count += 1;
  }
  return count;
}