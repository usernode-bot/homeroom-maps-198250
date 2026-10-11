// Locale parity for the weather strings (Phase 12G). The Indonesian bundle
// must fully cover the English weather.* keys, placeholders must match, the
// spec's word table must be used verbatim, and no user-facing string carries
// an em dash. Same convention as tests/offline.i18n.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let en;
let id;

test.before(async () => {
  en = (await import('../public/js/i18n/locales/en.js')).default;
  id = (await import('../public/js/i18n/locales/id.js')).default;
});

const PREFIXES = ['weather.'];

function keysOf(bundle) {
  return Object.keys(bundle).filter((k) => PREFIXES.some((p) => k.startsWith(p)));
}

test('every weather string in English exists in Indonesian', () => {
  const keys = keysOf(en);
  assert.ok(keys.length >= 20, `the weather section is present (${keys.length} keys)`);
  const missing = keys.filter((k) => typeof id[k] !== 'string' || !id[k].trim());
  assert.deepEqual(missing, []);
});

test('no weather string exists only in Indonesian', () => {
  const orphaned = keysOf(id).filter((k) => typeof en[k] !== 'string');
  assert.deepEqual(orphaned, []);
});

test('the spec word table is used verbatim', () => {
  assert.equal(en['weather.control'], 'Weather');
  assert.equal(id['weather.control'], 'Cuaca');
  assert.equal(en['weather.title'], 'Weather');
  assert.equal(id['weather.title'], 'Cuaca');
  assert.equal(en['weather.close'], 'Close');
  assert.equal(id['weather.close'], 'Tutup');
  assert.equal(en['weather.unavailableTitle'], 'Weather unavailable');
  assert.equal(id['weather.unavailableTitle'], 'Cuaca tidak tersedia');
  assert.equal(en['weather.checkAgain'], 'Check again');
  assert.equal(id['weather.checkAgain'], 'Periksa lagi');
  assert.equal(en['weather.loading'], 'Checking the weather…');
  assert.equal(id['weather.loading'], 'Memeriksa cuaca…');
  assert.equal(en['weather.offlineTitle'], 'No connection');
  assert.equal(id['weather.offlineTitle'], 'Tidak ada koneksi');
  assert.equal(en['weather.refresh'], 'Refresh');
  assert.equal(id['weather.refresh'], 'Muat ulang');
  assert.equal(en['weather.temperature'], 'Temperature');
  assert.equal(id['weather.temperature'], 'Suhu');
  assert.equal(en['weather.precipitation'], 'Precipitation');
  assert.equal(id['weather.precipitation'], 'Curah hujan');
  assert.equal(en['weather.wind'], 'Wind');
  assert.equal(id['weather.wind'], 'Angin');
});

test('the unavailable copy refuses to promise data and refuses to invent any', () => {
  // The one sentence the whole phase stands on: no source, nothing shown,
  // no fabricated weather.
  assert.match(en['weather.unavailableBody'], /No weather source is connected/);
  assert.match(en['weather.unavailableBody'], /does not display made-up weather/);
  assert.match(id['weather.unavailableBody'], /Belum ada sumber cuaca/);
  assert.match(id['weather.unavailableBody'], /tidak menampilkan cuaca buatan/);
});

test('weather interpolation placeholders match between the bundles', () => {
  const placeholders = (tpl) => [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keysOf(en)) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('no weather string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!PREFIXES.some((p) => key.startsWith(p))) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});

test('every weather key the control, panel and service call exists in both bundles', () => {
  // Pulled from the t('...') call sites in controls.js, weather-panel.js and
  // the panel's state bodies, so a renamed key cannot silently render
  // undefined.
  const used = [
    'weather.control', 'weather.controlSr', 'weather.title', 'weather.close',
    'weather.scope', 'weather.unavailableTitle', 'weather.unavailableBody',
    'weather.checkAgain', 'weather.loading', 'weather.offlineTitle',
    'weather.offlineBody', 'weather.errorTitle', 'weather.errorBody',
    'weather.refresh', 'weather.stale', 'weather.observed', 'weather.updated',
    'weather.temperature', 'weather.precipitation', 'weather.wind',
    'weather.source',
  ];
  const missingEn = used.filter((k) => typeof en[k] !== 'string');
  const missingId = used.filter((k) => typeof id[k] !== 'string');
  assert.deepEqual(missingEn, []);
  assert.deepEqual(missingId, []);
});
