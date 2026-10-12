// The 3D map strings (Phase 12H) — the en/id parity test, following the
// Phase 12A i18n test's pattern: every new key exists in BOTH bundles with
// the exact copy the screens render, and neither bundle carries an em dash.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PREFIXES = ['map.3d', 'map.terrain'];

// The verbatim copy each screen shows; a change here is a copy change and
// this test says so.
const EXPECTED_EN = {
  'map.3dTitle': '3D view',
  'map.terrainTitle': 'Terrain',
  'map.terrainSr': 'Show terrain elevation',
  'map.terrainFailed': 'Terrain could not load. The map still works without it.',
};
const EXPECTED_ID = {
  'map.3dTitle': 'Tampilan 3D',
  'map.terrainTitle': 'Relief',
  'map.terrainSr': 'Tampilkan ketinggian medan',
  'map.terrainFailed': 'Relief tidak dapat dimuat. Peta tetap berfungsi tanpa itu.',
};

let en = null;
let id = null;

test.before(async () => {
  en = (await import('../public/js/i18n/locales/en.js')).default;
  id = (await import('../public/js/i18n/locales/id.js')).default;
});

function keysWithPrefix(bundle) {
  return Object.keys(bundle)
    .filter((key) => PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
}

test('the 3D and terrain keys exist in BOTH bundles, with no strays', () => {
  assert.deepEqual(keysWithPrefix(en), Object.keys(EXPECTED_EN).sort());
  assert.deepEqual(keysWithPrefix(id), Object.keys(EXPECTED_ID).sort());
});

test('every 3D and terrain key renders the exact expected copy', () => {
  for (const [key, value] of Object.entries(EXPECTED_EN)) {
    assert.equal(en[key], value, `en ${key}`);
  }
  for (const [key, value] of Object.entries(EXPECTED_ID)) {
    assert.equal(id[key], value, `id ${key}`);
  }
});

test('no 3D or terrain string carries an em dash, in either language', () => {
  for (const bundle of [en, id]) {
    for (const key of keysWithPrefix(bundle)) {
      assert.ok(!String(bundle[key]).includes('—'), `${key} carries an em dash`);
    }
  }
});
