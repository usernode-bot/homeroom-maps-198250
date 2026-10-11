// Offline search service (Phase 12B).
//
// When the device is offline and at least one downloaded region is complete,
// search is answered from the tiles already stored in IndexedDB. Nothing here
// touches the network: indexes, tiles and results are all device-local, and a
// query while offline never leaves the device.
//
// The shape of the answer is deliberately the SAME normalized shape the online
// search stack returns (search/normalize.js), plus offline marks, so every
// surface that already renders a search result renders this one without
// learning a second model:
//
//   { id, kind, name, localName, detail,
//     address: {...nulls}, addressLine: null, lat, lon,
//     provider: 'offline-tiles',
//     offline: true, regionId, regionName, attribution }
//
// The index itself is ephemeral: it lives in memory, keyed per region by a
// version token derived from the manifest, and is rebuilt from the stored
// tiles the next time it is asked for after a reload. No index artifact is
// written and no payload format is invented; persisting an index is deferred
// until a format is authorized.
//
// The tile reader, the index core and this service are each injectable, so
// node:test drives the real code path against the fake IndexedDB store.
import {
  tilesForBounds,
} from './offline-tiles.js';
import {
  buildIndexFromTiles,
  createIndexCache,
  indexVersion,
  queryIndex,
} from './offline-search-index.js';
import { buildIndexChunked } from './offline-search-index-chunked.js';
import {
  OFFLINE_SEARCH_STAGE,
  OfflineSearchUnavailableError,
  isEligibleRegion,
  resolveOfflineSearchCapability,
} from './offline-search-capability.js';

// The OSM `place` class values mapped onto the app's existing kind vocabulary.
// The client keeps its own label keys (the server's Kind tables are not
// imported); an unknown class is an honest generic place.
const PLACE_KIND_KEY = {
  country: 'country',
  state: 'region',
  province: 'region',
  region: 'region',
  city: 'city',
  town: 'town',
  village: 'village',
  hamlet: 'village',
  suburb: 'suburb',
  quarter: 'suburb',
  neighbourhood: 'suburb',
  borough: 'suburb',
  city_district: 'suburb',
};

// Kind key -> the normalized search `kind` the rest of the app already knows.
const KIND_KEY_TO_SEARCH_KIND = {
  country: 'country',
  region: 'region',
  city: 'city',
  town: 'town',
  village: 'village',
  suburb: 'suburb',
  place: 'other',
};

export function placeKindKey(klass) {
  return PLACE_KIND_KEY[klass] || 'place';
}

// The English kind vocabulary, used when no localized label function was
// injected (a bare service in a test, or a screen that has not wired i18n).
// The shipped UI always injects `t()`-backed labels, so this is a fallback,
// never the visible copy in the app.
const DEFAULT_KIND_LABELS = {
  country: 'Country',
  region: 'Region',
  city: 'City',
  town: 'Town',
  village: 'Village',
  suburb: 'Neighbourhood',
  place: 'Place',
};

// Most recently completed first. `completedAt` is set when a download
// verified; `createdAt` is the fallback for a manifest that predates it.
function completionStamp(region) {
  return String(region.completedAt || region.createdAt || '');
}

export function createOfflineSearchService({
  store,
  capability = null,
  config = null,
  configProvider = null,
  env = null,
  labelFor = null,
  now = () => new Date(),
  maxNames = undefined,
  // The build path: the pure builder by default, or a worker/chunked reader
  // the browser injects. Same option shape either way, so tests drive the real
  // service without stubbing it.
  buildIndex = buildIndexFromTiles,
  cache = createIndexCache(),
} = {}) {
  if (!store) throw new Error('createOfflineSearchService needs a tile store.');

  function kindLabel(kindKey) {
    if (typeof labelFor === 'function') {
      const value = labelFor(kindKey);
      if (typeof value === 'string' && value) return value;
    }
    return DEFAULT_KIND_LABELS[kindKey] || DEFAULT_KIND_LABELS.place;
  }

  // Resolve the effective capability for this call. A fixed `capability`
  // object (tests) wins; otherwise the gate is resolved from the current
  // config and the real region list, so a region added or deleted after boot
  // is honored immediately rather than snapshotted. Fail closed: no config
  // provider and no capability means disabled, never ready.
  function currentCapability(regions) {
    if (capability) return capability;
    const source = typeof configProvider === 'function' ? configProvider() : config;
    if (source == null) return { stage: OFFLINE_SEARCH_STAGE.DISABLED };
    return resolveOfflineSearchCapability({ config: source, regions, ...(env ? { env } : {}) });
  }

  // The reason offline search cannot answer right now, or null when it can.
  async function gate() {
    const regions = await store.listRegions();
    const list = Array.isArray(regions) ? regions : [];
    const cap = currentCapability(list);
    if (!cap || cap.stage !== OFFLINE_SEARCH_STAGE.READY) {
      return { reason: (cap && cap.stage) || OFFLINE_SEARCH_STAGE.DISABLED, regions: [] };
    }
    const eligible = list.filter(isEligibleRegion);
    if (!eligible.length) return { reason: OFFLINE_SEARCH_STAGE.NO_REGIONS, regions: [] };
    return { reason: null, regions: eligible };
  }

  // The region a query searches: the one covering the map center when the
  // caller has one, otherwise the most recently completed. One region per
  // query honors the "no cross-region search" non-goal.
  function pickActiveRegion(regions, center) {
    if (center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lon))) {
      const lat = Number(center.lat);
      const lon = Number(center.lon);
      const covering = regions.find(
        (r) =>
          r.bounds &&
          lat >= r.bounds.south &&
          lat <= r.bounds.north &&
          lon >= r.bounds.west &&
          lon <= r.bounds.east,
      );
      if (covering) return covering;
    }
    return [...regions].sort((a, b) => completionStamp(b).localeCompare(completionStamp(a)))[0] || null;
  }

  // Read every tile the region planned out of the store. A tile that was
  // planned but is missing is skipped; a tile that cannot be read fails the
  // build honestly (the caller surfaces the error state, never fake results).
  async function readRegionTiles(region) {
    const planned = tilesForBounds(region.bounds, region.zoom);
    const tiles = [];
    for (const coord of planned) {
      const record = await store.getTile(region.id, coord.z, coord.x, coord.y);
      if (record && record.data != null && record.byteLength !== 0) {
        tiles.push({ z: coord.z, x: coord.x, y: coord.y, data: record.data });
      }
    }
    return tiles;
  }

  // Build (or reuse) the in-memory index for one region. Reuse keys on the
  // manifest's version token, so adding, replacing or deleting a region and
  // any change to its tiles/zoom range invalidates the cache entry.
  async function ensureIndex(region) {
    const version = indexVersion(region);
    const cached = cache.get(region.id, version);
    if (cached) return cached;
    const tiles = await readRegionTiles(region);
    const options = { regionId: region.id, bounds: region.bounds, zoom: region.zoom, tiles };
    if (Number.isInteger(maxNames)) options.maxNames = maxNames;
    // `buildIndex` is the pure builder in Node/tests; the browser injects the
    // worker/chunked reader (createWorkerTileIndexReader) under the same
    // signature, so this awaits either one.
    const index = await buildIndex(options);
    return cache.set(region.id, version, index);
  }

  // One index entry -> the normalized UI result the app already renders.
  function resultFromEntry(entry, region) {
    const kindKey = placeKindKey(entry.kind);
    const kind = KIND_KEY_TO_SEARCH_KIND[kindKey] || 'other';
    return {
      id: `${region.id}:${entry.foldedName}:${entry.lat.toFixed(4)},${entry.lon.toFixed(4)}`,
      kind,
      kindKey,
      kindClass: entry.kind,
      name: entry.name,
      localName: entry.latinName || null,
      detail: `${kindLabel(kindKey)}, ${region.name}`,
      address: {
        houseNumber: null,
        street: null,
        city: null,
        state: null,
        postcode: null,
        country: null,
        countryCode: null,
      },
      addressLine: null,
      lat: entry.lat,
      lon: entry.lon,
      provider: 'offline-tiles',
      offline: true,
      regionId: region.id,
      regionName: region.name,
      attribution: region.attribution || null,
    };
  }

  async function run(text, { limit = 10, center = null, bounds = null } = {}) {
    const { reason, regions } = await gate();
    if (reason) throw new OfflineSearchUnavailableError(reason);
    const region = pickActiveRegion(regions, center);
    if (!region) throw new OfflineSearchUnavailableError(OFFLINE_SEARCH_STAGE.NO_REGIONS);
    let index;
    try {
      index = await ensureIndex(region);
    } catch (err) {
      // A region whose tiles cannot be read is an honest failure, never an
      // empty (and so misleadingly successful) answer.
      throw new OfflineSearchUnavailableError(OFFLINE_SEARCH_STAGE.NO_REGIONS);
    }
    const clip = bounds || region.bounds || null;
    const entries = queryIndex(index, text, { bounds: clip, limit });
    return entries.map((entry) => resultFromEntry(entry, region));
  }

  return {
    // The reason offline search cannot answer, or null. Exposed so the panel
    // can choose copy before issuing a query.
    async availability() {
      const { reason } = await gate();
      return { stage: reason || OFFLINE_SEARCH_STAGE.READY, available: !reason, reason };
    },

    async activeRegion({ center = null } = {}) {
      const { regions } = await gate();
      return pickActiveRegion(regions, center);
    },

    search(text, options = {}) {
      return run(text, options);
    },

    // Offline has one query path: the same scan with the app's smaller
    // suggestion limit.
    suggest(text, options = {}) {
      return run(text, { limit: 8, ...options });
    },

    // Drop a region's cached index (a region was deleted or replaced).
    clear(regionId) {
      if (regionId == null) {
        cache.clear();
        return true;
      }
      return cache.delete(regionId);
    },

    // Read only side effects: no index is built, nothing is fetched.
    indexSize(region) {
      const idx = cache.get(region.id, indexVersion(region));
      return idx ? idx.entries.length : 0;
    },
  };
}

// The worker-backed tile reader: build a region's index in a module Web
// Worker when the browser supports module workers, and on the main thread
// (chunked and yielding, so the UI is never blocked) otherwise. Either way it
// calls the SAME pure builder, so the worker is an optimization, never a
// second implementation. A worker that fails falls back to the chunked path.
export function createWorkerTileIndexReader({ workerUrl = null, WorkerImpl = null } = {}) {
  const WorkerCtor =
    WorkerImpl || (typeof Worker !== 'undefined' ? Worker : null);
  let worker = null;
  let requestId = 0;
  const pending = new Map();

  function ensureWorker() {
    if (worker || !WorkerCtor) return worker;
    try {
      worker = new WorkerCtor(
        workerUrl || new URL('./offline-search-index.worker.js', import.meta.url),
        { type: 'module' },
      );
      worker.addEventListener('message', (event) => {
        const message = event && event.data;
        if (!message || message.requestId == null) return;
        const slot = pending.get(message.requestId);
        if (!slot) return;
        pending.delete(message.requestId);
        if (message.type === 'error') slot.reject(new Error(message.message || 'Worker build failed'));
        else slot.resolve(message.index);
      });
      worker.addEventListener('error', () => {
        // The worker is gone; the next build falls back to the main thread.
        for (const slot of pending.values()) slot.reject(new Error('The index worker failed.'));
        pending.clear();
        worker = null;
      });
    } catch {
      worker = null;
    }
    return worker;
  }

  return async function readTiles(options) {
    const tiles = Array.isArray(options.tiles) ? options.tiles : [];
    const active = ensureWorker();
    if (active) {
      try {
        requestId += 1;
        const id = requestId;
        const index = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          active.postMessage({
            type: 'build',
            requestId: id,
            regionId: options.regionId,
            bounds: options.bounds || null,
            zoom: options.zoom || null,
            tiles,
          });
        });
        return index;
      } catch {
        /* fall through to the chunked main-thread build */
      }
    }
    return buildIndexChunked({ ...options, tiles });
  };
}
