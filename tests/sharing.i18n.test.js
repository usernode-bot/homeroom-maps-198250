// Locale parity for the location-sharing strings (Phase 12F, and the start
// sheet's failure copy added with it). The Indonesian bundle is
// hand-maintained and must fully cover the English bundle's user-facing
// sharing.* keys; this test keeps a new sharing.* key from silently
// degrading to English. Follows trips.i18n.test.js's pattern.
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

test('every sharing.* key in the English bundle exists in Indonesian', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('sharing.'));
  assert.ok(keys.length > 50, `the sharing section is present (${keys.length} keys)`);
  const missing = keys.filter((key) => typeof id[key] !== 'string' || !id[key].trim());
  assert.deepEqual(missing, []);
});

test('no sharing.* key exists only in Indonesian (stale keys are removed)', () => {
  const orphaned = Object.keys(id).filter(
    (key) => key.startsWith('sharing.') && typeof en[key] !== 'string',
  );
  assert.deepEqual(orphaned, []);
});

test('sharing interpolation placeholders match between the bundles', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('sharing.'));
  const placeholders = (template) => [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('no sharing string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!key.startsWith('sharing.')) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});

test('the start sheet failure keys are all present in both bundles', () => {
  const required = [
    'sharing.starting',
    'sharing.activeUntil',
    'sharing.locationDeniedBody',
    'sharing.locationFailedTitle',
    'sharing.locationFailedBody',
    'sharing.locationReopeningTitle',
    'sharing.locationReopeningBody',
    'sharing.noShellBody',
    'sharing.startNetworkBody',
    'sharing.startRateLimitedBody',
    'sharing.startRecipientsBody',
    'sharing.startServerBody',
  ];
  for (const bundle of [en, id]) {
    for (const key of required) {
      assert.equal(typeof bundle[key], 'string', `${key} must exist`);
      assert.ok(bundle[key].trim().length > 0, `${key} must not be blank`);
    }
  }
});
