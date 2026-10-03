// The download orchestrator (Phase 12A): the B2 refusal, the full plan →
// fetch → store → verify → complete run, cancellation with resume, the
// storage budget guard and the style failure path. Everything runs against
// the real store implementation and a counting fake fetch, so what is
// asserted is what the browser code would do.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let createDownloadManager;
let DOWNLOAD_STATUS;
let DOWNLOAD_REASON;
let createRegionService;
let createTileStore;

test.before(async () => {
  ({ createDownloadManager, DOWNLOAD_STATUS, DOWNLOAD_REASON } = await import(
    '../public/js/services/offline-download.js'
  ));
  ({ createRegionService } = await import('../public/js/services/offline-regions.js'));
  ({ createTileStore } = await import('../public/js/services/offline-tiles.js'));
  const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');
  globalThis.IDBKeyRange = globalThis.IDBKeyRange || { only: (value) => ({ __only: value }) };
  globalThis.__downloadFakeIDB = createFakeIndexedDB;
});

const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const STYLE = {
  version: 8,
  sources: {
    base: { type: 'vector', url: 'https://tiles.openfreemap.org/planet/tiles.json' },
  },
  sprite: 'https://tiles.openfreemap.org/sprite',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  layers: [{ type: 'symbol', layout: { 'text-font': ['Noto Sans Regular'] } }],
};

const TILEJSON = { tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}{ratio}.pbf'] };

const TILE_RE = /\/(\d+)\/(\d+)\/(\d+)\.pbf/;

// A fake fetch that serves the style document chain. Counters record every
// URL class so the tests can prove exactly what was and was not requested.
function makeFetch({ tileSize = 24, onTile = null } = {}) {
  const calls = { style: 0, tilejson: 0, sprite: 0, glyph: 0, tile: 0 };
  const tileCalls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const body = (bytes) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes,
    });
    if (u.startsWith('https://style.example/')) {
      calls.style += 1;
      return body(new TextEncoder().encode(JSON.stringify(STYLE)).buffer);
    }
    if (u.includes('tiles.json')) {
      calls.tilejson += 1;
      return body(new TextEncoder().encode(JSON.stringify(TILEJSON)).buffer);
    }
    if (u.includes('/sprite')) {
      // The @2x variants miss (optional); the base set serves.
      if (u.includes('@2x')) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      calls.sprite += 1;
      return body(new Uint8Array([9, 9]).buffer);
    }
    if (u.includes('/fonts/')) {
      calls.glyph += 1;
      return body(new Uint8Array([7]).buffer);
    }
    const tile = u.match(TILE_RE);
    if (tile) {
      calls.tile += 1;
      tileCalls.push({ z: Number(tile[1]), x: Number(tile[2]), y: Number(tile[3]) });
      if (onTile) await onTile(u, opts);
      return body(new Uint8Array(tileSize).buffer);
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fetch: fn, calls, tileCalls };
}

const READY_CAPABILITY = {
  stage: 'ready',
  downloadsEnabled: true,
  swRequired: true,
  maxStorageBytes: 64 * 1024 * 1024,
  presets: [],
};

const SMALL_PRESET = {
  id: 'micro',
  name: 'Micro area',
  bounds: { west: 106.8, south: -6.25, east: 106.82, north: -6.23 },
  zoom: { min: 15, max: 15 },
  format: 'mvt',
};

function setup() {
  const store = createTileStore({ indexedDB: createFakeIndexedDB() });
  const regionService = createRegionService({ store });
  return { store, regionService };
}

function progressLog() {
  const events = [];
  return { events, onProgress: (p) => events.push(p) };
}

test('the B2 refusal issues ZERO network requests and creates no region', async () => {
  const { store, regionService } = setup();
  const { fetch, calls } = makeFetch();
  const manager = createDownloadManager({ store, fetchImpl: fetch, tileDelayMs: 0, concurrency: 1 });
  const result = await manager.start({
    capability: { stage: 'provider_blocked', downloadsEnabled: false, blocker: 'B2' },
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    regionService,
  });
  assert.equal(result.status, DOWNLOAD_STATUS.BLOCKED);
  assert.equal(result.blocker, 'B2');
  assert.equal(result.tilesDone, 0);
  assert.deepEqual(calls, { style: 0, tilejson: 0, sprite: 0, glyph: 0, tile: 0 });
  assert.deepEqual(await store.listRegions(), []);
  // No capability at all refuses too.
  const again = await manager.start({ preset: SMALL_PRESET, regionService });
  assert.equal(again.status, DOWNLOAD_STATUS.BLOCKED);
});

test('a successful run plans, fetches, stores, verifies and completes', async () => {
  const { store, regionService } = setup();
  const { fetch, calls } = makeFetch();
  const { events, onProgress } = progressLog();
  const manager = createDownloadManager({ store, fetchImpl: fetch, tileDelayMs: 0, concurrency: 2 });

  const result = await manager.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    onProgress,
    regionService,
  });

  assert.equal(result.status, DOWNLOAD_STATUS.COMPLETED);
  const plan = (await import('../public/js/services/offline-tiles.js')).tilesForBounds(
    SMALL_PRESET.bounds,
    SMALL_PRESET.zoom,
  );
  assert.equal(result.tilesTotal, plan.length);
  assert.equal(result.tilesDone, plan.length);
  assert.ok(result.bytesDone > 0);
  assert.ok(Array.isArray(result.hosts) && result.hosts.includes('tiles.openfreemap.org'));

  // The manifest says complete, with real counts and a completion time.
  const manifest = await store.getRegion(result.manifest.id);
  assert.equal(manifest.status, 'complete');
  assert.ok(manifest.completedAt);
  assert.equal(manifest.tileCount, plan.length);
  assert.equal(manifest.artifacts[0].status, 'complete');

  // Every planned tile is stored with bytes; the byte accounting is the
  // store's real usage, equal to what the run reported.
  const usage = await store.regionUsage(manifest.id);
  assert.equal(usage.tiles.count, plan.length);
  assert.equal(usage.bytes, result.bytesDone);

  // The style chain was fetched: style, TileJSON, both sprite bases, both
  // glyph ranges; the optional @2x variants miss without failing the run.
  assert.equal(calls.style, 1);
  assert.equal(calls.tilejson, 1);
  assert.equal(calls.sprite, 2);
  assert.equal(calls.glyph, 2);

  // Progress told the truth: a resources phase, then monotonic tile counts.
  assert.ok(events.some((e) => e.phase === 'resources'));
  const tileEvents = events.filter((e) => e.phase === 'tiles');
  assert.ok(tileEvents.length >= 2);
  for (let i = 1; i < tileEvents.length; i += 1) {
    assert.ok(tileEvents[i].done >= tileEvents[i - 1].done);
  }
  const last = tileEvents[tileEvents.length - 1];
  assert.equal(last.done, plan.length);
});

test('a zero-length tile fails verification instead of completing', async () => {
  const { store, regionService } = setup();
  // Every third tile serves zero bytes; the verifier must catch it.
  let n = 0;
  const { fetch } = makeFetch({
    onTile: () => {
      n += 1;
    },
  });
  const manager = createDownloadManager({
    store,
    fetchImpl: async (url, opts) => {
      const res = await fetch(url, opts);
      const tile = String(url).match(TILE_RE);
      if (tile && n % 3 === 1) {
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return res;
    },
    tileDelayMs: 0,
    concurrency: 1,
  });

  const result = await manager.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'A',
    regionService,
  });

  assert.equal(result.status, DOWNLOAD_STATUS.FAILED);
  assert.equal(result.reason, DOWNLOAD_REASON.VERIFICATION);
  const manifests = await store.listRegions();
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].status, 'failed');
  assert.equal(manifests[0].failedReason, DOWNLOAD_REASON.VERIFICATION);
});

test('the storage budget guard refuses before anything is fetched or created', async () => {
  const { store, regionService } = setup();
  const { fetch, calls } = makeFetch();
  const manager = createDownloadManager({ store, fetchImpl: fetch, tileDelayMs: 0, maxTiles: 1 });
  const result = await manager.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'A',
    regionService,
  });
  assert.equal(result.status, DOWNLOAD_STATUS.FAILED);
  assert.equal(result.reason, DOWNLOAD_REASON.STORAGE_BUDGET);
  assert.deepEqual(await store.listRegions(), []);
  assert.equal(calls.tile, 0);
});

test('a style without tile templates fails honestly', async () => {
  const { store, regionService } = setup();
  const emptyStyle = { ...STYLE, sources: { base: { type: 'vector', url: 'https://tiles.openfreemap.org/empty.json' } } };
  const { fetch } = makeFetch();
  const manager = createDownloadManager({
    store,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.startsWith('https://style.example/')) {
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(emptyStyle)).buffer };
      }
      if (u.includes('empty.json')) {
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({})).buffer };
      }
      return fetch(url);
    },
    tileDelayMs: 0,
  });
  const result = await manager.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'A',
    regionService,
  });
  assert.equal(result.status, DOWNLOAD_STATUS.FAILED);
  assert.equal(result.reason, DOWNLOAD_REASON.STYLE);
  assert.equal((await store.listRegions())[0].status, 'failed');
});

test('cancellation leaves the manifest interrupted with real progress, and resume completes by skipping stored tiles', async () => {
  const { store, regionService } = setup();
  const { fetch, calls, tileCalls } = makeFetch();
  const manager = createDownloadManager({ store, fetchImpl: fetch, tileDelayMs: 0, concurrency: 1 });

  // Cancel from inside the third tile fetch, and honour the abort signal the
  // way a real fetch would.
  let activeManager = null;
  let tileFetchCount = 0;
  const abortingFetch = async (url, opts) => {
    const tile = String(url).match(TILE_RE);
    if (tile) {
      tileFetchCount += 1;
      if (tileFetchCount === 3 && activeManager) activeManager.cancel();
      if (opts && opts.signal && opts.signal.aborted) {
        const err = new Error('The download was cancelled.');
        err.name = 'AbortError';
        throw err;
      }
    }
    return fetch(url, opts);
  };

  const first = createDownloadManager({ store, fetchImpl: abortingFetch, tileDelayMs: 0, concurrency: 1 });
  activeManager = first;
  const cancelledResult = await first.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    regionService,
  });

  assert.equal(cancelledResult.status, DOWNLOAD_STATUS.CANCELLED);
  assert.equal(cancelledResult.tilesDone, 2, 'two tiles completed before the abort');
  const interrupted = (await store.listRegions())[0];
  assert.equal(interrupted.status, 'interrupted');
  assert.ok(interrupted.interruptedAt);
  const partialUsage = await store.regionUsage(interrupted.id);
  assert.equal(partialUsage.tiles.count, 2);

  // Resume into the SAME region: only the missing tiles are fetched.
  const tilesBefore = tileCalls.length;
  const resumeManager = createDownloadManager({ store, fetchImpl: fetch, tileDelayMs: 0, concurrency: 1 });
  const resumed = await resumeManager.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    regionService,
    existingRegion: interrupted,
  });
  assert.equal(resumed.status, DOWNLOAD_STATUS.COMPLETED);
  assert.equal(resumed.tilesDone, resumed.tilesTotal);
  const complete = await store.getRegion(interrupted.id);
  assert.equal(complete.status, 'complete');
  assert.equal((await store.regionUsage(complete.id)).tiles.count, resumed.tilesTotal);
  // The resume fetched at most the missing tiles: the two stored ones were
  // skipped, never re-requested.
  assert.ok(calls.tile - tilesBefore <= resumed.tilesTotal - 2, 'resume skips stored tiles');
});

test('a quota write failure surfaces as the storage-limit reason', async () => {
  const { store, regionService } = setup();
  const { fetch } = makeFetch();
  // The failing store rejects tile writes with a QuotaExceededError.
  const quotaStore = new Proxy(store, {
    get(target, prop) {
      if (prop === 'putTile') {
        return async () => {
          const err = new Error('quota');
          err.name = 'QuotaExceededError';
          throw err;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const quotaService = createRegionService({ store: quotaStore });
  const manager = createDownloadManager({ store: quotaStore, fetchImpl: fetch, tileDelayMs: 0, concurrency: 1 });
  const result = await manager.start({
    capability: READY_CAPABILITY,
    preset: SMALL_PRESET,
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://style.example/liberty',
    attribution: 'A',
    regionService: quotaService,
  });
  assert.equal(result.status, DOWNLOAD_STATUS.FAILED);
  assert.equal(result.reason, DOWNLOAD_REASON.STORAGE_LIMIT);
  assert.equal((await store.listRegions())[0].failedReason, 'storage_limit');
});