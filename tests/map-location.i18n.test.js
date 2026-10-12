// The denied-location help strings — the en/id parity test, following the
// Phase 12H i18n test's pattern: every new key exists in BOTH bundles with
// the exact copy the screens render, and neither bundle carries an em dash.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PREFIXES = ['map.allowLocation', 'map.settings'];

// The verbatim copy each screen shows; a change here is a copy change and
// this test says so.
const EXPECTED_EN = {
  'map.allowLocation': 'Allow location',
  'map.settingsTitle': "Turn on location in your phone's settings",
  'map.settingsStep1': "Open your phone's Settings app.",
  'map.settingsStep2': 'Go to Location (on iPhone: Privacy & Security, then Location Services).',
  'map.settingsStep3': 'Allow location for the browser or Homeroom app you use.',
  'map.settingsStep4': 'Come back here and tap Allow location. If Homeroom asks, choose Allow.',
};
const EXPECTED_ID = {
  'map.allowLocation': 'Izinkan lokasi',
  'map.settingsTitle': 'Aktifkan lokasi di pengaturan ponsel Anda',
  'map.settingsStep1': 'Buka aplikasi Pengaturan di ponsel Anda.',
  'map.settingsStep2': 'Buka Lokasi (di iPhone: Privasi & Keamanan, lalu Layanan Lokasi).',
  'map.settingsStep3': 'Izinkan lokasi untuk browser atau aplikasi Homeroom yang Anda gunakan.',
  'map.settingsStep4': 'Kembali ke sini dan ketuk Izinkan lokasi. Jika Homeroom bertanya, pilih Izinkan.',
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

test('the denied-location help keys exist in BOTH bundles, with no strays', () => {
  assert.deepEqual(keysWithPrefix(en), Object.keys(EXPECTED_EN).sort());
  assert.deepEqual(keysWithPrefix(id), Object.keys(EXPECTED_ID).sort());
});

test('every denied-location help key renders the exact expected copy', () => {
  for (const [key, value] of Object.entries(EXPECTED_EN)) {
    assert.equal(en[key], value, `en ${key}`);
  }
  for (const [key, value] of Object.entries(EXPECTED_ID)) {
    assert.equal(id[key], value, `id ${key}`);
  }
});

test('no denied-location help string carries an em dash, in either language', () => {
  for (const bundle of [en, id]) {
    for (const key of keysWithPrefix(bundle)) {
      assert.ok(!String(bundle[key]).includes('—'), `${key} carries an em dash`);
    }
  }
});
