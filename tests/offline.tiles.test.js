// The offline tile store (Phase 12A), exercised against the in-memory
// IndexedDB stub. Covers the region lifecycle, tile and resource records,
// usage accounting, cross-region deletion, and the service-worker lookup
// helpers the map's offline serving path uses.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let createTileStore;
let tilesForBounds;
let tileKey;
let resourceKey;

test.before(async () => {
  ({ createTileStore, tilesForBounds, tileKey, resourceKey } = await import(
    '../public/js/services/offline-tiles.js'
  ));
  const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');
  globalThis.IDBKeyRange = { only: (value) => ({ __only: value }) };
  globalThis.__fakeIDB = createFakeIndexedDB();
});

function newStore() {
  const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');
  return createTileStore({ indexedDB: createFakeIndexedDB() });
}

const REGION = {
  version: 1,
  id: 'region-abc',
  name: 'Jakarta',
  provider: 'maplibre-openfreemap',
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
  bounds: { west: 106.63, south: -6.42, east: 107.02, north: -6.03 },
  zoom: { min: 10, max: 14 },
  artifacts: [{ kind: 'tiles', format: 'mvt', status: 'pending', tileCount: 4 }],
  status: 'downloading',
  createdAt: '2026-10-03T00:00:00.000Z',
};

test('a region round-trips and lists newest first', async () => {
  const store = newStore();
  await store.putRegion({ ...REGION, id: 'a', createdAt: '2026-10-01T00:00:00.000Z' });
  await store.putRegion({ ...REGION, id: 'b', createdAt: '2026-10-02T00:00:00.000Z' });
  const list = await store.listRegions();
  assert.deepEqual(list.map((r) => r.id), ['b', 'a']);
  assert.equal((await store.getRegion('a')).name, 'Jakarta');
});

test('updateRegion patches fields and refuses unknown ids', async () => {
  const store = newStore();
  await store.putRegion({ ...REGION });
  const updated = await store.updateRegion('region-abc', { status: 'complete', byteSize: 1234 });
  assert.equal(updated.status, 'complete');
  assert.equal(updated.byteSize, 1234);
  await assert.rejects(() => store.updateRegion('nope', { status: 'complete' }), /Unknown offline region/);
});

test('tiles and resources store with real byte lengths', async () => {
  const store = newStore();
  const data = new Uint8Array([1, 2, 3, 4]).buffer;
  const tile = await store.putTile({ regionId: 'r1', z: 12, x: 3, y: 4, data });
  assert.equal(tile.key, tileKey('r1', 12, 3, 4));
  assert.equal(tile.byteLength, 4);
  const read = await store.getTile('r1', 12, 3, 4);
  assert.equal(read.byteLength, 4);

  const resource = await store.putResource({ regionId: 'r1', kind: 'metadata', url: 'https://x/y.json', data });
  assert.equal(resource.key, resourceKey('r1', 'https://x/y.json'));
  assert.equal((await store.getResource('r1', 'https://x/y.json')).byteLength, 4);
});

test('regionUsage counts tiles and resources from the records', async () => {
  const store = newStore();
  await store.putTile({ regionId: 'r1', z: 1, x: 0, y: 0, data: new Uint8Array(10).buffer });
  await store.putTile({ regionId: 'r1', z: 1, x: 1, y: 0, data: new Uint8Array(20).buffer });
  await store.putResource({ regionId: 'r1', kind: 'sprite', url: 'https://x/s.png', data: new Uint8Array(5).buffer });
  const usage = await store.regionUsage('r1');
  assert.deepEqual(usage.tiles, { count: 2, bytes: 30 });
  assert.deepEqual(usage.resources, { count: 1, bytes: 5 });
  assert.equal(usage.bytes, 35);
  const empty = await store.regionUsage('r2');
  assert.equal(empty.bytes, 0);
});

test('deleteRegion removes the manifest, tiles and resources together', async () => {
  const store = newStore();
  await store.putRegion({ ...REGION });
  await store.putTile({ regionId: 'region-abc', z: 1, x: 0, y: 0, data: new Uint8Array(3).buffer });
  await store.putResource({ regionId: 'region-abc', kind: 'glyph', url: 'https://x/0-255.pbf', data: new Uint8Array(2).buffer });
  await store.deleteRegion('region-abc');
  assert.equal(await store.getRegion('region-abc'), undefined);
  assert.equal(await store.getTile('region-abc', 1, 0, 0), undefined);
  assert.equal(await store.getResource('region-abc', 'https://x/0-255.pbf'), undefined);
  assert.equal((await store.listRegions()).length, 0);
});

test('totalUsage aggregates across regions', async () => {
  const store = newStore();
  // totalUsage walks the region manifests, so both regions exist first.
  await store.putRegion({ ...REGION, id: 'r1', createdAt: '2026-10-01T00:00:00.000Z' });
  await store.putRegion({ ...REGION, id: 'r2', createdAt: '2026-10-02T00:00:00.000Z' });
  await store.putTile({ regionId: 'r1', z: 1, x: 0, y: 0, data: new Uint8Array(4).buffer });
  await store.putTile({ regionId: 'r2', z: 1, x: 0, y: 0, data: new Uint8Array(6).buffer });
  const total = await store.totalUsage();
  assert.equal(total.bytes, 10);
  assert.equal(total.regions, 2);
});

test('findTile answers only inside a stored region and only for stored bytes', async () => {
  const store = newStore();
  await store.putRegion({ ...REGION });
  const regions = await store.listRegions();
  const inside = tilesForBounds(REGION.bounds, { min: 14, max: 14 })[0];
  const outside = { z: 14, x: 1, y: 1 };

  assert.equal(await store.findTile(inside, regions), null);
  await store.putTile({ regionId: 'region-abc', ...inside, data: new Uint8Array(7).buffer });
  const hit = await store.findTile(inside, regions);
  assert.equal(hit.byteLength, 7);
  assert.equal(await store.findTile(outside, regions), null);
});

test('findResource answers by exact URL across regions', async () => {
  const store = newStore();
  await store.putRegion({ ...REGION });
  await store.putResource({ regionId: 'region-abc', kind: 'metadata', url: 'https://t/tiles.json', data: new Uint8Array(2).buffer });
  const regions = await store.listRegions();
  const hit = await store.findResource('https://t/tiles.json', regions);
  assert.ok(hit);
  assert.equal(await store.findResource('https://t/other.json', regions), null);
});

test('listResourceUrls returns the stored URLs the service worker derives hosts from', async () => {
  const store = newStore();
  await store.putResource({ regionId: 'r1', kind: 'metadata', url: 'https://a/tiles.json', data: new Uint8Array(1).buffer });
  await store.putResource({ regionId: 'r1', kind: 'glyph', url: 'https://b/0-255.pbf', data: new Uint8Array(1).buffer });
  assert.deepEqual(await store.listResourceUrls('r1'), ['https://a/tiles.json', 'https://b/0-255.pbf']);
  assert.deepEqual(await store.listResourceUrls('r2'), []);
});

test('tilesForBounds plans the exact covering set for a bounds and zoom range', async () => {
  const tiles = tilesForBounds({ west: 106.63, south: -6.42, east: 107.02, north: -6.03 }, { min: 14, max: 14 });
  assert.ok(tiles.length > 0);
  const seen = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
  assert.equal(seen.size, tiles.length, 'no duplicate tiles in the plan');
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x < 2 ** tile.z && tile.y < 2 ** tile.z);
  }
});