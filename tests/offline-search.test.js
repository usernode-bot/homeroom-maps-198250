// Offline search integration (Phase 12B): the store-driven service against
// the fake IndexedDB store, the result shape, active-region selection, and the
// fetcher routing that proves no network call happens while offline and that
// only a genuine network-class failure degrades to offline results.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const FIXTURE = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'offline-search-place.mvt')));
const TILE = { z: 12, x: 3263, y: 2118 };
const REGION = {
  version: 1,
  id: 'r1',
  name: 'Staging demo area',
  provider: 'maplibre-openfreemap',
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
  bounds: { west: 106.75, south: -6.25, east: 106.9, north: -6.1 },
  zoom: { min: 12, max: 12 },
  artifacts: [{ kind: 'tiles', format: 'mvt', status: 'complete', tileCount: 1 }],
  status: 'complete',
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:00.000Z',
};

let createTileStore;
let createOfflineSearchService;
let cap;
let moduleCounter = 0;

test.before(async () => {
  globalThis.IDBKeyRange = { only: (value) => ({ __only: value }) };
  ({ createTileStore } = await import('../public/js/services/offline-tiles.js'));
  ({ createOfflineSearchService } = await import('../public/js/services/offline-search.js'));
  cap = await import('../public/js/services/offline-search-capability.js');
});

const ENABLED = { environment: 'staging', offline: { search: { enabled: true } } };

async function seededStore({ regions = [REGION], tiles = true } = {}) {
  const idb = createFakeIndexedDB();
  globalThis.indexedDB = idb;
  const store = createTileStore({ indexedDB: idb });
  for (const region of regions) await store.putRegion(region);
  if (tiles) await store.putTile({ regionId: REGION.id, ...TILE, data: FIXTURE });
  return store;
}

function service(store, overrides = {}) {
  return createOfflineSearchService({ store, config: ENABLED, env: { indexedDB: true }, ...overrides });
}

test('a query returns the normalized UI shape marked offline', async () => {
  const store = await seededStore();
  const svc = service(store);
  const results = await svc.search('staging demo place', { limit: 10 });
  assert.equal(results.length, 4);
  const row = results[0];
  assert.equal(row.name, 'Staging demo Place A');
  assert.equal(row.provider, 'offline-tiles');
  assert.equal(row.offline, true);
  assert.equal(row.regionId, 'r1');
  assert.equal(row.regionName, 'Staging demo area');
  assert.equal(row.attribution, 'OpenFreeMap, OpenMapTiles, OpenStreetMap');
  assert.equal(row.addressLine, null);
  assert.deepEqual(row.address, {
    houseNumber: null,
    street: null,
    city: null,
    state: null,
    postcode: null,
    country: null,
    countryCode: null,
  });
  // Every field the online result shape guarantees is present, so the shared
  // row/card render it unchanged.
  for (const key of ['id', 'kind', 'name', 'localName', 'detail', 'lat', 'lon']) {
    assert.ok(key in row, `result carries ${key}`);
  }
});

test('the active region is the one covering the center, else the most recent', async () => {
  const older = { ...REGION, id: 'old', name: 'Older', createdAt: '2025-01-01T00:00:00.000Z', completedAt: '2025-01-01T00:00:00.000Z' };
  const newer = { ...REGION, id: 'new', name: 'Newer', createdAt: '2026-06-01T00:00:00.000Z', completedAt: '2026-06-01T00:00:00.000Z' };
  const store = await seededStore({ regions: [older, newer] });
  const svc = service(store);
  // No center: most recently completed wins.
  assert.equal((await svc.activeRegion()).id, 'new');
  // A center inside the older region's own bounds (make them distinct).
  await store.putRegion({ ...older, bounds: { west: 10, south: 10, east: 11, north: 11 } });
  const picked = await svc.activeRegion({ center: { lat: 10.5, lon: 10.5 } });
  assert.equal(picked.id, 'old');
});

test('only the place layer is searched and results honor the limit', async () => {
  const store = await seededStore();
  const svc = service(store);
  assert.equal((await svc.suggest('staging demo place', { limit: 2 })).length, 2);
});

test('no network is used: the service never touches fetch', async () => {
  const store = await seededStore();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('offline search must not fetch');
  };
  try {
    const svc = service(store);
    await svc.search('staging demo place', { limit: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test('no_regions is a typed unavailable error', async () => {
  const store = await seededStore({ regions: [], tiles: false });
  const svc = service(store);
  await assert.rejects(() => svc.search('x'), (err) => {
    assert.equal(err.code, 'offline_unavailable');
    assert.equal(err.reason, cap.OFFLINE_SEARCH_STAGE.NO_REGIONS);
    return true;
  });
});

test('disabled and unsupported_browser are typed unavailable errors', async () => {
  const store = await seededStore();
  const disabled = createOfflineSearchService({
    store,
    config: { offline: { search: { enabled: false } } },
    env: { indexedDB: true },
  });
  await assert.rejects(() => disabled.search('x'), (err) => err.reason === 'disabled');

  const unsupported = createOfflineSearchService({
    store,
    config: ENABLED,
    env: { indexedDB: false },
  });
  await assert.rejects(() => unsupported.search('x'), (err) => err.reason === 'unsupported_browser');
});

test('deleting a region makes it disappear from the answer immediately', async () => {
  const store = await seededStore();
  const svc = service(store);
  assert.equal((await svc.search('staging demo place', { limit: 10 })).length, 4);
  await store.deleteRegion(REGION.id);
  await assert.rejects(() => svc.search('staging demo place'), (err) => err.reason === 'no_regions');
});

// ---- fetcher routing (services/search.js) ----
//
// These drive the real fetchers with a stubbed network. Each scenario imports
// a FRESH copy of search.js (query-string cache bust) so its singleton offline
// service and its URL override are per-scenario, exactly like a page load.

function browserGlobals({ search = '', hash = '', onLine = false } = {}) {
  globalThis.window = { location: { search, hash } };
  // Node 22 exposes `navigator` as a getter-only global; define it explicitly.
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine },
    configurable: true,
    writable: true,
  });
}

async function freshSearch(config = ENABLED) {
  const state = await import('../public/js/state.js');
  state.setState({ config });
  moduleCounter += 1;
  return import(`../public/js/services/search.js?v=${moduleCounter}`);
}

test('offline fetchers answer from the store with fetch never called', async () => {
  const store = await seededStore();
  const idb = globalThis.indexedDB;
  browserGlobals({ search: '?offline=1', onLine: false });
  globalThis.indexedDB = idb;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('must not fetch offline');
  };
  const search = await freshSearch();
  const results = await search.fetchSearch('staging demo place');
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.offline === true));
  assert.equal(calls, 0);
  // The scope is exposed for the panel's empty-state copy.
  assert.equal(search.offlineScope().regionName, 'Staging demo area');
  assert.equal(search.isOffline(), true);
});

test('a network-class failure degrades to offline results and marks them', async () => {
  const store = await seededStore();
  const idb = globalThis.indexedDB;
  browserGlobals({ hash: '#/discover', onLine: true });
  globalThis.indexedDB = idb;
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const search = await freshSearch();
  const results = await search.fetchSearch('staging demo place');
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.offline === true));
  // Not the offline path: the degraded notice distinguishes it.
  assert.equal(search.isOffline(), false);
});

test('an HTTP error is not a network failure: it is rethrown, never masked', async () => {
  await seededStore();
  browserGlobals({ onLine: true });
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { code: 'internal_error', message: 'boom' } }),
    });
  const search = await freshSearch();
  await assert.rejects(() => search.fetchSearch('staging demo place'), (err) => {
    assert.equal(err.code, 'internal_error');
    assert.notEqual(err.code, 'offline_unavailable');
    return true;
  });
});

test('offline with no stored regions rejects with the typed reason', async () => {
  const store = await seededStore({ regions: [], tiles: false });
  const idb = globalThis.indexedDB;
  browserGlobals({ search: '?offline=1', onLine: false });
  globalThis.indexedDB = idb;
  globalThis.fetch = () => {
    throw new Error('must not fetch');
  };
  const search = await freshSearch();
  await assert.rejects(() => search.fetchSearch('anything'), (err) => {
    assert.equal(err.code, 'offline_unavailable');
    assert.equal(err.reason, 'no_regions');
    return true;
  });
  void store;
});
