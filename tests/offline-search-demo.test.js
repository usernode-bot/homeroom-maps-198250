// The staging-only offline search demo seed (Phase 12B). It must be a no-op
// outside staging, idempotent, device-local only, and its seeded region must
// be eligible for the real search path.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const FIXTURE = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'offline-search-place.mvt')));

let demo;
let createTileStore;

test.before(async () => {
  globalThis.IDBKeyRange = { only: (value) => ({ __only: value }) };
  demo = await import('../public/js/services/offline-search-demo.js');
  ({ createTileStore } = await import('../public/js/services/offline-tiles.js'));
});

function fakeFetch() {
  return () =>
    Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(FIXTURE.buffer.slice(0)) });
}

test('the seed runs only on staging with the seed flag', () => {
  assert.equal(demo.shouldSeedOfflineSearchDemo({ seed: true, environment: 'staging' }), true);
  assert.equal(demo.shouldSeedOfflineSearchDemo({ seed: true, environment: 'production' }), false);
  assert.equal(demo.shouldSeedOfflineSearchDemo({ seed: false, environment: 'staging' }), false);
  assert.equal(demo.shouldSeedOfflineSearchDemo({ seed: true, environment: undefined }), false);
  assert.equal(demo.shouldSeedOfflineSearchDemo({}), false);
});

test('the seed writes a manifest-shaped region and its fixture tile, idempotently', async () => {
  const store = createTileStore({ indexedDB: createFakeIndexedDB() });
  await demo.seedOfflineSearchDemo({ store, fetchImpl: fakeFetch() });
  await demo.seedOfflineSearchDemo({ store, fetchImpl: fakeFetch() }); // re-run: idempotent

  const regions = await store.listRegions();
  assert.equal(regions.length, 1);
  const region = regions[0];
  assert.equal(region.name, 'Staging demo area');
  assert.equal(region.status, 'complete');
  assert.ok(region.artifacts.some((a) => a.kind === 'tiles' && a.status === 'complete'));
  assert.equal(region.attribution, 'OpenFreeMap, OpenMapTiles, OpenStreetMap');
  // Never a real manifest field fabricated beyond the contract's shape.
  assert.equal(region.version, 1);
  assert.ok(region.bounds && region.zoom);

  const tile = await store.getTile(region.id, demo.DEMO_TILE.z, demo.DEMO_TILE.x, demo.DEMO_TILE.y);
  assert.ok(tile && tile.byteLength === FIXTURE.byteLength);
});

test('a failed fixture fetch throws and stores no tile, so boot stays honest', async () => {
  const store = createTileStore({ indexedDB: createFakeIndexedDB() });
  const failing = () => Promise.resolve({ ok: false, status: 404 });
  await assert.rejects(() => demo.seedOfflineSearchDemo({ store, fetchImpl: failing }), /fixture fetch failed/i);
});

test('the seeded region is eligible and searchable through the real service', async () => {
  const store = createTileStore({ indexedDB: createFakeIndexedDB() });
  await demo.seedOfflineSearchDemo({ store, fetchImpl: fakeFetch() });
  const { createOfflineSearchService } = await import('../public/js/services/offline-search.js');
  const { resolveOfflineSearchCapability } = await import('../public/js/services/offline-search-capability.js');
  const config = { environment: 'staging', offline: { search: { enabled: true } } };
  const regions = await store.listRegions();
  assert.equal(resolveOfflineSearchCapability({ config, regions, env: { indexedDB: true } }).stage, 'ready');
  const svc = createOfflineSearchService({ store, config, env: { indexedDB: true } });
  const results = await svc.search('staging demo place');
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.offline === true && r.regionName === 'Staging demo area'));
});
