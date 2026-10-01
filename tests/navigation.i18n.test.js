// Locale parity for the navigation strings (Phase 8). The Indonesian bundle
// is hand-maintained and must fully cover the English bundle's
// user-facing keys — en.js is the permanent fallback, so a missing key in
// another bundle degrades silently to English; this test keeps that from
// happening to the new navigation section.
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

test('every navigation.* key in the English bundle exists in Indonesian', () => {
  const navKeys = Object.keys(en).filter((key) => key.startsWith('navigation.'));
  assert.ok(navKeys.length > 40, `the navigation section is present (${navKeys.length} keys)`);
  const missing = navKeys.filter((key) => typeof id[key] !== 'string' || !id[key].trim());
  assert.deepEqual(missing, []);
});

test('no navigation.* key exists only in Indonesian (stale keys are removed)', () => {
  const orphaned = Object.keys(id).filter(
    (key) => key.startsWith('navigation.') && typeof en[key] !== 'string',
  );
  assert.deepEqual(orphaned, []);
});

test('navigation interpolation placeholders match between the bundles', () => {
  const navKeys = Object.keys(en).filter((key) => key.startsWith('navigation.'));
  const placeholders = (template) => [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of navKeys) {
    assert.deepEqual(
      placeholders(id[key]),
      placeholders(en[key]),
      `placeholders of ${key} must match`,
    );
  }
});

test('no navigation string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!key.startsWith('navigation.')) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});