// The minimal offline-search MVT reader (Phase 12B). Driven against the
// committed fixture tile so the decoder, the fixture and the demo seed all
// agree on one real byte layout.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let decoder;
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'offline-search-place.mvt'));
const TILE = { z: 12, x: 3263, y: 2118 };

test.before(async () => {
  decoder = await import('../public/js/services/offline-search-tiles.js');
});

function read(bytes = FIXTURE, tileRef = TILE) {
  return decoder.readPlaceFeatures(new Uint8Array(bytes), tileRef);
}

test('the fixture decodes into named place features', () => {
  const features = read();
  const names = features.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'Staging demo Place A',
    'Staging demo Place B',
    'Staging demo Place C',
    'Staging demo Place D',
  ]);
});

test('a feature carries its class and optional latin name', () => {
  const features = read();
  const a = features.find((f) => f.name === 'Staging demo Place A');
  assert.equal(a.klass, 'city');
  assert.equal(a.latinName, null); // no latin name on this one
  const b = features.find((f) => f.name === 'Staging demo Place B');
  assert.equal(b.klass, 'town');
  assert.equal(b.latinName, 'Staging demo Place B (latin)');
});

test('geometry yields a point inside the tile', () => {
  const features = read();
  for (const feature of features) {
    // The fixture sits around Java: every decoded point must land near it,
    // proving the command integers were applied, not just parsed.
    assert.ok(feature.lon > 106.7 && feature.lon < 106.9, `${feature.name} lon ${feature.lon}`);
    assert.ok(feature.lat > -6.3 && feature.lat < -6.05, `${feature.name} lat ${feature.lat}`);
  }
});

test('a polygon feature yields its first vertex as the representative point', () => {
  const d = read().find((f) => f.name === 'Staging demo Place D');
  assert.ok(d, 'the polygon feature decodes');
  assert.equal(d.klass, 'place');
  assert.ok(Number.isFinite(d.lon) && Number.isFinite(d.lat));
});

test('malformed bytes fail closed with the typed error', () => {
  assert.throws(() => read([0x1a, 0xff, 0xff]), (err) => err.code === 'mvt_decode_error');
  assert.throws(() => decoder.readPlaceFeatures(new Uint8Array([0x1a]), TILE), /truncated/i);
  assert.throws(() => decoder.readPlaceFeatures('not bytes', TILE), (err) => err.code === 'mvt_decode_error');
});

test('a tile with no place layer yields no features, not an error', () => {
  // Field 3 (layers) is absent entirely: an empty tile is a real answer.
  assert.deepEqual(decoder.readPlaceFeatures(new Uint8Array([]), TILE), []);
});

test('only the place layer is read', () => {
  // Re-encode the fixture's place layer under a different layer name at the
  // tile level and confirm the reader ignores it.
  const bytes = new Uint8Array(FIXTURE);
  const layerStart = 3; // after 0x1a <len> varint header
  const renamed = Buffer.from(bytes);
  const nameAt = renamed.indexOf(Buffer.from('place'), layerStart);
  assert.ok(nameAt > 0);
  Buffer.from('roads').copy(renamed, nameAt);
  assert.deepEqual(decoder.readPlaceFeatures(new Uint8Array(renamed), TILE), []);
});
