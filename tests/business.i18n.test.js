// Locale parity for the business strings (Phase 12J). The Indonesian bundle
// is hand-maintained and must fully cover the English bundle's user-facing
// keys — en.js is the permanent fallback, so a missing key degrades silently
// to English; this test keeps that from happening to the business section.
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

test('every business.* key in the English bundle exists in Indonesian', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('business.'));
  assert.ok(keys.length > 50, `the business section is present (${keys.length} keys)`);
  const missing = keys.filter((key) => typeof id[key] !== 'string' || !id[key].trim());
  assert.deepEqual(missing, []);
});

test('the profile card line for business is in both bundles', () => {
  assert.ok(en['profile.businessBody']);
  assert.ok(id['profile.businessBody']);
});

test('no business.* key exists only in Indonesian (stale keys are removed)', () => {
  const orphaned = Object.keys(id).filter(
    (key) => key.startsWith('business.') && typeof en[key] !== 'string',
  );
  assert.deepEqual(orphaned, []);
});

test('business interpolation placeholders match between the bundles', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('business.'));
  const placeholders = (template) => [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('the five rejection reasons are named in both bundles', () => {
  for (const code of ['insufficient_evidence', 'not_your_business', 'duplicate_place', 'contact_unreachable', 'abuse']) {
    assert.ok(en[`business.rejectReason.${code}`], code);
    assert.ok(id[`business.rejectReason.${code}`], code);
  }
});

test('count-bearing copy is a single key with {days}, never plural branches', () => {
  assert.ok(/\{days\}/.test(en['business.pendingDays']), 'en pendingDays carries {days}');
  assert.ok(/\{days\}/.test(id['business.pendingDays']), 'id pendingDays carries {days}');
});

test('the reserved word: "Verified" is the reviewer decision, in both bundles', () => {
  // The chip labels the spec reserves: verification is ONLY a reviewer
  // decision, so the copy never says verified about a pending claim.
  assert.equal(en['business.verifiedChip'], 'Verified business');
  assert.equal(id['business.verifiedChip'], 'Bisnis terverifikasi');
});

test('no business string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!key.startsWith('business.') && key !== 'profile.businessBody') continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});
