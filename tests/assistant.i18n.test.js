// Locale parity for the assistant strings (Phase 11). The Indonesian bundle
// is hand-maintained and must fully cover the English assistant.* keys; this
// test keeps a new key from silently degrading to English in Indonesian, and
// keeps the two bundles' interpolation placeholders in step.
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

test('every assistant.* key in English exists in Indonesian', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('assistant.'));
  assert.ok(keys.length >= 25, `the assistant section is present (${keys.length} keys)`);
  const missing = keys.filter((k) => typeof id[k] !== 'string' || !id[k].trim());
  assert.deepEqual(missing, []);
});

test('no assistant.* key exists only in Indonesian', () => {
  const orphaned = Object.keys(id).filter((k) => k.startsWith('assistant.') && typeof en[k] !== 'string');
  assert.deepEqual(orphaned, []);
});

test('assistant interpolation placeholders match between the bundles', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('assistant.'));
  const placeholders = (tpl) => [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('no assistant string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!key.startsWith('assistant.')) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});
