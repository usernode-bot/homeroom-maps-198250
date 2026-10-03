// Offline tile store — browser-local IndexedDB storage for offline regions.
//
// Three object stores in one database ('hm-offline'):
//
//   regions    one record per region manifest (RegionManifest v1 shape),
//   tiles      the downloaded map tiles, keyed `regionId|z/x/y`,
//   resources  the required map resources a region needs to render: the
//              resolved style, TileJSON documents, sprites and glyphs,
//              keyed `regionId|kind|url`.
//
// Tile payloads live ONLY here. localStorage is never used for tile or
// resource bytes (platform rule and Phase 12A spec), and nothing is sent to
// the server: this store is device-local by design.
//
// `indexedDB` is injectable so node:test can drive the store against a
// minimal IndexedDB implementation without stubbing the store itself — the
// same object shape the browser provides is what the tests must supply.
'use strict';

const DB_NAME = 'hm-offline';
const DB_VERSION = 1;

const STORE_REGIONS = 'regions';
const STORE_TILES = 'tiles';
const STORE_RESOURCES = 'resources';

export const TILE_STORES = { DB_NAME, DB_VERSION, STORE_REGIONS, STORE_TILES, STORE_RESOURCES };

export function tileKey(regionId, z, x, y) {
  return `${regionId}|${z}/${x}/${y}`;
}

// Slippy-map tile math. The download planner and the service worker's
// bounds check share this one implementation, so what a region plans, what
// it stores and what the worker will serve are always the same coordinates.
export function longitudeToTileX(lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  // Clamp into the valid tile range: the antimeridian edge (lng 180) and
  // rounding at the projection limits must never yield an out-of-range tile.
  return Math.min(Math.max(x, 0), n - 1);
}

export function latitudeToTileY(lat, zoom) {
  const n = Math.pow(2, zoom);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  // The Web Mercator latitude limit (85.05112878 when rounded for display)
  // lands a hair past the projection edge and floors to -1: clamp to row 0.
  return Math.min(Math.max(y, 0), n - 1);
}

export function tileCovered(region, z, x, y) {
  if (z < region.zoom.min || z > region.zoom.max) return false;
  const n = Math.pow(2, z);
  const bounds = region.bounds;
  if (x < longitudeToTileX(bounds.west, z) || x > longitudeToTileX(bounds.east, z)) return false;
  const yMin = latitudeToTileY(bounds.north, z);
  const yMax = latitudeToTileY(bounds.south, z);
  return y >= yMin && y <= yMax;
}

// Every tile coordinate a region plans to store, zoom level by zoom level.
export function tilesForBounds(bounds, zoomRange) {
  const tiles = [];
  for (let z = zoomRange.min; z <= zoomRange.max; z += 1) {
    const n = Math.pow(2, z);
    const xMin = Math.max(longitudeToTileX(bounds.west, z), 0);
    const xMax = Math.min(longitudeToTileX(bounds.east, z), n - 1);
    const yMin = Math.max(latitudeToTileY(bounds.north, z), 0);
    const yMax = Math.min(latitudeToTileY(bounds.south, z), n - 1);
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) tiles.push({ z, x, y });
    }
  }
  return tiles;
}

export function resourceKey(regionId, url) {
  return `${regionId}|${String(url)}`;
}

// Normalize fetched bytes to an ArrayBuffer so what is verified is what is
// served. A zero-length payload is stored as-is: the download verifier, not
// the store, decides whether that fails the region.
function toBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new TypeError('tile/resource data must be ArrayBuffer or a typed array');
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function createTileStore({ indexedDB, dbName = DB_NAME, dbVersion = DB_VERSION } = {}) {
  const factory = indexedDB || globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available in this environment');

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(dbName, dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_REGIONS)) {
          db.createObjectStore(STORE_REGIONS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_TILES)) {
          const tiles = db.createObjectStore(STORE_TILES, { keyPath: 'key' });
          tiles.createIndex('byRegion', 'regionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_RESOURCES)) {
          const resources = db.createObjectStore(STORE_RESOURCES, { keyPath: 'key' });
          resources.createIndex('byRegion', 'regionId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the offline database'));
      request.onblocked = () => reject(new Error('The offline database is blocked by another connection'));
    });
    return dbPromise;
  }

  async function withStores(names, mode, fn) {
    const db = await open();
    const tx = db.transaction(names, mode);
    const stores = {};
    for (const name of names) stores[name] = tx.objectStore(name);
    const result = await fn(stores);
    await transactionDone(tx);
    return result;
  }

  // Iterate every record of one region via the byRegion index and collect
  // `fn(record)` results. Cursor-based, so a large region never needs to be
  // materialized all at once.
  function collectRegion(store, regionId, fn, range) {
    return new Promise((resolve, reject) => {
      const results = [];
      const cursorRequest = store.index('byRegion').openCursor(
        range || IDBKeyRange.only(regionId),
      );
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve(results);
        results.push(fn(cursor.value));
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('IndexedDB cursor failed'));
    });
  }

  const store = {
    async ready() {
      return open();
    },

    async close() {
      if (!dbPromise) return;
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    },

    // ---- region manifests ----

    async putRegion(region) {
      await withStores([STORE_REGIONS], 'readwrite', async (stores) => {
        await requestToPromise(stores[STORE_REGIONS].put(region));
      });
      return region;
    },

    async getRegion(id) {
      return withStores([STORE_REGIONS], 'readonly', (stores) =>
        requestToPromise(stores[STORE_REGIONS].get(id)));
    },

    async listRegions() {
      return withStores([STORE_REGIONS], 'readonly', async (stores) => {
        const all = await requestToPromise(stores[STORE_REGIONS].getAll());
        return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      });
    },

    async updateRegion(id, patch) {
      return withStores([STORE_REGIONS], 'readwrite', async (stores) => {
        const current = await requestToPromise(stores[STORE_REGIONS].get(id));
        if (!current) throw new Error(`Unknown offline region: ${id}`);
        const next = { ...current, ...patch, id };
        await requestToPromise(stores[STORE_REGIONS].put(next));
        return next;
      });
    },

    // Deletes the manifest, every tile and every resource of the region, in
    // one transaction, so a failure mid-way cannot leave orphaned bytes.
    async deleteRegion(id) {
      return withStores([STORE_REGIONS, STORE_TILES, STORE_RESOURCES], 'readwrite', async (stores) => {
        await new Promise((resolve, reject) => {
          let pending = 2;
          const finish = () => {
            pending -= 1;
            if (!pending) resolve();
          };
          for (const name of [STORE_TILES, STORE_RESOURCES]) {
            const cursorRequest = stores[name].index('byRegion').openCursor(IDBKeyRange.only(id));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return finish();
              cursor.delete();
              cursor.continue();
            };
            cursorRequest.onerror = () => reject(cursorRequest.error);
          }
        });
        await requestToPromise(stores[STORE_REGIONS].delete(id));
      });
    },

    // ---- tiles ----

    async putTile({ regionId, z, x, y, data }) {
      const buffer = toBuffer(data);
      const record = {
        key: tileKey(regionId, z, x, y),
        regionId,
        z,
        x,
        y,
        data: buffer,
        byteLength: buffer.byteLength,
        storedAt: new Date().toISOString(),
      };
      await withStores([STORE_TILES], 'readwrite', async (stores) => {
        await requestToPromise(stores[STORE_TILES].put(record));
      });
      return record;
    },

    async getTile(regionId, z, x, y) {
      return withStores([STORE_TILES], 'readonly', (stores) =>
        requestToPromise(stores[STORE_TILES].get(tileKey(regionId, z, x, y))));
    },

    // ---- required map resources (style, TileJSON, sprites, glyphs) ----

    async putResource({ regionId, kind, url, data }) {
      const buffer = toBuffer(data);
      const record = {
        key: resourceKey(regionId, url),
        regionId,
        kind,
        url: String(url),
        data: buffer,
        byteLength: buffer.byteLength,
        storedAt: new Date().toISOString(),
      };
      await withStores([STORE_RESOURCES], 'readwrite', async (stores) => {
        await requestToPromise(stores[STORE_RESOURCES].put(record));
      });
      return record;
    },

    async getResource(regionId, url) {
      return withStores([STORE_RESOURCES], 'readonly', (stores) =>
        requestToPromise(stores[STORE_RESOURCES].get(resourceKey(regionId, url))));
    },

    // ---- usage ----

    // Real byte and record counts for one region, counted from the store.
    async regionUsage(regionId) {
      return withStores([STORE_TILES, STORE_RESOURCES], 'readonly', async (stores) => {
        const tiles = await collectRegion(stores[STORE_TILES], regionId, (r) => r.byteLength || 0);
        const resources = await collectRegion(stores[STORE_RESOURCES], regionId, (r) => r.byteLength || 0);
        return {
          tiles: { count: tiles.length, bytes: tiles.reduce((a, b) => a + b, 0) },
          resources: { count: resources.length, bytes: resources.reduce((a, b) => a + b, 0) },
          bytes: tiles.reduce((a, b) => a + b, 0) + resources.reduce((a, b) => a + b, 0),
        };
      });
    },

    // Usage across every stored region. Used by the screen's storage line.
    async totalUsage() {
      const regions = await store.listRegions();
      const parts = await Promise.all(regions.map((region) => store.regionUsage(region.id)));
      return {
        regions: regions.length,
        bytes: parts.reduce((a, b) => a + b.bytes, 0),
      };
    },

    // The device's own quota estimate, when the browser exposes it. Values
    // are advisory; the storage-limit state keys on real write failures.
    async estimateQuota() {
      try {
        if (globalThis.navigator && globalThis.navigator.storage && typeof globalThis.navigator.storage.estimate === 'function') {
          const estimate = await globalThis.navigator.storage.estimate();
          return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
        }
      } catch {
        /* estimate is best-effort */
      }
      return null;
    },

    // Service-worker lookup: does ANY stored region cover this tile, and is
    // it stored? `regions` is the caller's in-memory region list. Bounds
    // checks run in tile coordinates so the answer matches what was planned.
    async findTile({ z, x, y }, regions) {
      for (const region of regions) {
        if (!tileCovered(region, z, x, y)) continue;
        const hit = await store.getTile(region.id, z, x, y);
        if (hit && hit.byteLength > 0) return hit;
      }
      return null;
    },

    // Service-worker lookup for a required resource URL across regions.
    async findResource(url, regions) {
      for (const region of regions) {
        const hit = await store.getResource(region.id, url);
        if (hit && hit.byteLength > 0) return hit;
      }
      return null;
    },

    // The stored resource URLs of one region. The service worker derives its
    // host allowlist from these (plus each manifest's style URL), so the
    // worker's eligibility set survives a boot with no client announcement.
    async listResourceUrls(regionId) {
      return withStores([STORE_RESOURCES], 'readonly', (stores) =>
        collectRegion(stores[STORE_RESOURCES], regionId, (r) => r.url));
    },
  };

  return store;
}