// Locale parity for the reports strings (Phase 6). The Indonesian bundle
// is hand-maintained and must fully cover the English bundle's user-facing
// keys — en.js is the permanent fallback, so a missing key in another
// bundle degrades silently to English; this test keeps that from happening
// to the new reports section.
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

test('every reports.* key in the English bundle exists in Indonesian', () => {
  const reportKeys = Object.keys(en).filter((key) => key.startsWith('reports.'));
  assert.ok(reportKeys.length > 40, `the reports section is present (${reportKeys.length} keys)`);
  const missing = reportKeys.filter((key) => typeof id[key] !== 'string' || !id[key].trim());
  assert.deepEqual(missing, []);
});

test('the eleven report types and four statuses are named in both bundles', () => {
  for (const slug of ['traffic', 'accident', 'road_closed', 'construction', 'hazard', 'flood', 'fire', 'broken_road', 'wrong_map_data', 'place_closed', 'other']) {
    assert.ok(en[`reports.type.${slug}`], slug);
    assert.ok(id[`reports.type.${slug}`], slug);
  }
  for (const status of ['pending', 'verified', 'rejected', 'expired']) {
    assert.ok(en[`reports.status.${status}`], status);
    assert.ok(id[`reports.status.${status}`], status);
  }
});

test('no reports.* key exists only in Indonesian (stale keys are removed)', () => {
  const orphaned = Object.keys(id).filter(
    (key) => key.startsWith('reports.') && typeof en[key] !== 'string',
  );
  assert.deepEqual(orphaned, []);
});

test('reports interpolation placeholders match between the bundles', () => {
  const reportKeys = Object.keys(en).filter((key) => key.startsWith('reports.'));
  const placeholders = (template) => [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of reportKeys) {
    assert.deepEqual(
      placeholders(id[key]),
      placeholders(en[key]),
      `placeholders of ${key} must match`,
    );
  }
});

test('count-bearing copy is single count keys, never plural branches', () => {
  for (const key of ['reports.confirmCount', 'reports.disagreeCount']) {
    assert.ok(/\{count\}/.test(en[key]), `${key} carries {count}`);
    assert.ok(/\{count\}/.test(id[key]), `${key} carries {count}`);
  }
});

test('no reports string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!key.startsWith('reports.')) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});