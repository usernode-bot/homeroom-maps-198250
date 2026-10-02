// Locale parity for the trips strings (Phase 10). The Indonesian bundle is
// hand-maintained and must fully cover the English bundle's user-facing keys;
// this test keeps a new trips.* key from silently degrading to English.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let en;
let id;

before(async () => {
  en = (await import('../public/js/i18n/locales/en.js')).default;
  id = (await import('../public/js/i18n/locales/id.js')).default;
});

test('every trips.* key in the English bundle exists in Indonesian', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('trips.'));
  assert.ok(keys.length > 40, `the trips section is present (${keys.length} keys)`);
  const missing = keys.filter((key) => typeof id[key] !== 'string' || !id[key].trim());
  assert.deepEqual(missing, []);
});

test('no trips.* key exists only in Indonesian (stale keys are removed)', () => {
  const orphaned = Object.keys(id).filter(
    (key) => key.startsWith('trips.') && typeof en[key] !== 'string',
  );
  assert.deepEqual(orphaned, []);
});

test('trips interpolation placeholders match between the bundles', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('trips.'));
  const placeholders = (template) => [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('no trips string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!key.startsWith('trips.')) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});
