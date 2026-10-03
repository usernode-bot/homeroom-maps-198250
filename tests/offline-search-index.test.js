// The offline search index core (Phase 12B): building from real fixture
// features, matching, ordering, bounds, dedupe, limits and the region cache.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let core;
const FIXTURE = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'offline-search-place.mvt')));
const TILE = { z: 12, x: 3263, y: 2118, data: FIXTURE };

test.before(async () => {
  core = await import('../public/js/services/offline-search-index.js');
});

function build(overrides = {}) {
  return core.buildIndexFromTiles({
    regionId: 'r1',
    bounds: { west: 106.75, south: -6.25, east: 106.9, north: -6.1 },
    zoom: { min: 12, max: 12 },
    tiles: [TILE],
    ...overrides,
  });
}

test('build folds every named place into one entry', () => {
  const index = build();
  assert.equal(index.regionId, 'r1');
  assert.equal(index.entries.length, 4);
  assert.equal(index.failedTiles, 0);
  const entry = index.entries.find((e) => e.name === 'Staging demo Place B');
  assert.equal(entry.kind, 'town');
  assert.equal(entry.latinName, 'Staging demo Place B (latin)');
  assert.ok(Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
});

test('matching ignores case and diacritics', () => {
  const index = build();
  assert.equal(core.queryIndex(index, 'STAGING DEMO PLACE A')[0].name, 'Staging demo Place A');
  // The fold helper strips combining marks so an accented query matches.
  assert.equal(core.foldText('Café'), 'cafe');
  assert.equal(core.foldText('  Bandung  '), 'bandung');
});

test('prefix matches rank above substring matches', () => {
  const index = {
    entries: [
      { name: 'Xplace', foldedName: 'xplace', foldedLatin: null, lat: 0, lon: 0 },
      { name: 'Place X', foldedName: 'place x', foldedLatin: null, lat: 0, lon: 0 },
    ],
  };
  const results = core.queryIndex(index, 'place', { limit: 10 });
  assert.deepEqual(results.map((e) => e.name), ['Place X', 'Xplace']);
});

test('bounds filtering drops results outside the rectangle', () => {
  const index = build();
  const all = core.queryIndex(index, 'staging demo place', { limit: 10 });
  assert.equal(all.length, 4);
  const outside = core.queryIndex(index, 'staging demo place', {
    bounds: { west: 0, south: 0, east: 1, north: 1 },
    limit: 10,
  });
  assert.equal(outside.length, 0);
});

test('the same place at two zoom levels collapses to one entry', () => {
  const index = build({ tiles: [TILE, TILE] });
  assert.equal(index.entries.length, 4);
});

test('limit caps the answer', () => {
  const index = build();
  assert.equal(core.queryIndex(index, 'staging demo place', { limit: 2 }).length, 2);
});

test('an empty query returns nothing, never everything', () => {
  const index = build();
  assert.deepEqual(core.queryIndex(index, '', { limit: 10 }), []);
  assert.deepEqual(core.queryIndex(index, '   ', { limit: 10 }), []);
});

test('a corrupt tile is skipped and counted, never thrown', () => {
  const index = build({ tiles: [{ z: 12, x: 1, y: 1, data: new Uint8Array([0x1a, 0xff, 0xff]) }, TILE] });
  assert.equal(index.failedTiles, 1);
  assert.equal(index.entries.length, 4); // the good tile still contributed
});

test('the region cache invalidates on a version change and deleteIndex clears it', () => {
  const cache = core.createIndexCache();
  const manifest = { id: 'r1', createdAt: '2026-01-01T00:00:00.000Z', zoom: { min: 12, max: 12 } };
  const v1 = core.indexVersion(manifest);
  const index = build();
  cache.set('r1', v1, index);
  assert.equal(cache.get('r1', v1), index);
  // A completed download changes the token, so the stale index is not reused.
  const v2 = core.indexVersion({ ...manifest, completedAt: '2026-02-01T00:00:00.000Z' });
  assert.notEqual(v1, v2);
  assert.equal(cache.get('r1', v2), null);
  assert.equal(core.deleteIndex({ r1: index }, 'r1'), true);
  assert.equal(cache.delete('r1'), true);
  assert.equal(cache.size(), 0);
});

test('names past the cap are dropped and reported, not silently growing', () => {
  const index = build({ maxNames: 2 });
  assert.equal(index.entries.length, 2);
  assert.equal(index.dropped, 2);
});

test('the chunked build yields between tiles and matches the pure build', async () => {
  const { buildIndexChunked } = await import('../public/js/services/offline-search-index-chunked.js');
  let yields = 0;
  const index = await buildIndexChunked(
    { regionId: 'r1', bounds: null, zoom: null, tiles: [TILE, TILE, TILE, TILE] },
    { budget: 2, yieldTo: () => { yields += 1; return Promise.resolve(); } },
  );
  assert.equal(yields, 2); // 4 tiles, budget 2
  // Same dedupe result as the synchronous builder.
  assert.equal(index.entries.length, 4);
});

test('the worker reader falls back to the chunked main thread without Worker', async () => {
  const { createWorkerTileIndexReader } = await import('../public/js/services/offline-search.js');
  // In Node there is no module-Worker global, so the reader must still return
  // a usable index through the chunked path.
  const reader = createWorkerTileIndexReader({ WorkerImpl: null });
  const index = await reader({ regionId: 'r1', bounds: null, zoom: null, tiles: [TILE] });
  assert.equal(index.entries.length, 4);
});

test('the worker reader uses the injected Worker and posts a build message', async () => {
  const { createWorkerTileIndexReader } = await import('../public/js/services/offline-search.js');
  const listeners = {};
  const posted = [];
  class FakeWorker {
    constructor() { this._listeners = listeners; }
    addEventListener(type, fn) { listeners[type] = fn; }
    postMessage(msg) {
      posted.push(msg);
      // Reply asynchronously, like a real worker.
      queueMicrotask(() => listeners.message({ data: { type: 'index', requestId: msg.requestId, index: { entries: [], failedTiles: 0 } } }));
    }
  }
  const reader = createWorkerTileIndexReader({ WorkerImpl: FakeWorker });
  const index = await reader({ regionId: 'r1', bounds: null, zoom: null, tiles: [TILE] });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'build');
  assert.equal(index.entries.length, 0);
});
