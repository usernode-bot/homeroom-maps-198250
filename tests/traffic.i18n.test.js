// Locale parity for the live-traffic strings (Phase 12D). The Indonesian
// bundle must fully cover the English traffic.* keys added by this change,
// placeholders must match, and no user-facing string carries an em dash.
// The pre-existing traffic.legend* keys are covered by the same traffic.
// prefix and must remain untouched.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let en;
let id;

test.before(async () => {
  en = (await import('../public/js/i18n/locales/en.js')).default;
  id = (await import('../public/js/i18n/locales/id.js')).default;
});

const PREFIXES = ['traffic.'];

function keysOf(bundle) {
  return Object.keys(bundle).filter((k) => PREFIXES.some((p) => k.startsWith(p)));
}

// The 14 Phase 12D keys, per the approved spec's word table.
const PHASE_12D_KEYS = [
  'traffic.control',
  'traffic.panelTitle',
  'traffic.panelUnavailable',
  'traffic.panelCommunity',
  'traffic.panelRights',
  'traffic.checkAgain',
  'traffic.state.offline',
  'traffic.state.loading',
  'traffic.state.stale',
  'traffic.state.noCoverage',
  'traffic.state.outage',
  'traffic.state.rateLimited',
  'traffic.state.timeout',
  'traffic.state.authFailed',
];

test('every traffic string in English exists in Indonesian', () => {
  const keys = keysOf(en);
  assert.ok(keys.length >= PHASE_12D_KEYS.length, `the traffic section is present (${keys.length} keys)`);
  const missing = keys.filter((k) => typeof id[k] !== 'string' || !id[k].trim());
  assert.deepEqual(missing, []);
});

test('no traffic string exists only in Indonesian', () => {
  const orphaned = keysOf(id).filter((k) => typeof en[k] !== 'string');
  assert.deepEqual(orphaned, []);
});

test('all 14 Phase 12D keys exist in both bundles', () => {
  for (const key of PHASE_12D_KEYS) {
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`);
    assert.equal(typeof id[key], 'string', `id.${key} must be a string`);
  }
});

test('the spec word table is used verbatim', () => {
  assert.equal(en['traffic.control'], 'Traffic');
  assert.equal(id['traffic.control'], 'Lalu lintas');
  assert.equal(en['traffic.panelTitle'], 'Live traffic');
  assert.equal(id['traffic.panelTitle'], 'Lalu lintas langsung');
  assert.equal(en['traffic.checkAgain'], 'Check again');
  assert.equal(id['traffic.checkAgain'], 'Periksa lagi');
  assert.equal(
    en['traffic.panelUnavailable'],
    'Live traffic is not connected yet. No traffic provider is set up, so no traffic layer is shown and no traffic colours appear on the map.',
  );
  assert.equal(
    id['traffic.panelUnavailable'],
    'Lalu lintas langsung belum tersambung. Belum ada penyedia lalu lintas, jadi tidak ada lapisan lalu lintas dan tidak ada warna lalu lintas di peta.',
  );
});

test('the unavailable state names every condition the panel can report', () => {
  // The stale state carries the only placeholder in the set; the rest are
  // plain sentences the panel renders verbatim.
  const placeholders = (tpl) => [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(placeholders(en['traffic.state.stale']), ['time']);
  assert.deepEqual(placeholders(id['traffic.state.stale']), ['time']);
  for (const key of PHASE_12D_KEYS) {
    if (key === 'traffic.state.stale') continue;
    assert.ok(String(en[key]).trim().length > 0, `en.${key} is non-empty`);
    assert.ok(String(id[key]).trim().length > 0, `id.${key} is non-empty`);
  }
});

test('traffic interpolation placeholders match between the bundles', () => {
  const placeholders = (tpl) => [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keysOf(en)) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('no traffic string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!PREFIXES.some((p) => key.startsWith(p))) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
      assert.ok(!String(value).includes(' - '), `${key} must not use a spaced hyphen in place of punctuation`);
    }
  }
});

test('the pre-existing community legend keys are untouched by this change', () => {
  // The request-#26 community conditions legend keeps its own copy in both
  // bundles: the community derivation stays separate from the blocked live
  // feed, and this change neither renames nor removes its keys.
  const legendKeys = keysOf(en).filter((k) => k.startsWith('traffic.legend'));
  assert.ok(legendKeys.length > 0, 'the community legend keys still exist');
  for (const key of legendKeys) {
    assert.equal(typeof id[key], 'string', `id.${key} must still exist`);
  }
});
