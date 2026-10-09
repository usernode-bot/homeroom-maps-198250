// The offline search capability gate (Phase 12B): the stage matrix, the
// fail-closed behavior on a missing/malformed config, and device-support
// injection.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let cap;

test.before(async () => {
  cap = await import('../public/js/services/offline-search-capability.js');
});

const REGION = {
  id: 'r1',
  name: 'Jakarta',
  status: 'complete',
  bounds: { west: 106, south: -7, east: 107, north: -6 },
  zoom: { min: 10, max: 14 },
  artifacts: [{ kind: 'tiles', format: 'mvt', status: 'complete', tileCount: 4 }],
};

const ready = { offline: { search: { enabled: true, blocker: null, reason: null } } };
const env = { indexedDB: true };

test('ready: flag on, IndexedDB present and a complete region with tiles', () => {
  const resolved = cap.resolveOfflineSearchCapability({ config: ready, regions: [REGION], env });
  assert.equal(resolved.stage, cap.OFFLINE_SEARCH_STAGE.READY);
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.regions.map((r) => r.id), ['r1']);
});

test('no_regions: flag on and IndexedDB present, but nothing eligible', () => {
  const resolved = cap.resolveOfflineSearchCapability({ config: ready, regions: [], env });
  assert.equal(resolved.stage, cap.OFFLINE_SEARCH_STAGE.NO_REGIONS);
  assert.equal(resolved.enabled, false);
});

test('unsupported_browser: IndexedDB missing, whatever the config says', () => {
  const resolved = cap.resolveOfflineSearchCapability({
    config: ready,
    regions: [REGION],
    env: { indexedDB: false },
  });
  assert.equal(resolved.stage, cap.OFFLINE_SEARCH_STAGE.UNSUPPORTED_BROWSER);
  assert.equal(resolved.enabled, false);
});

test('disabled: the operator switch off', () => {
  const resolved = cap.resolveOfflineSearchCapability({
    config: { offline: { search: { enabled: false, blocker: 'operator', reason: 'off' } } },
    regions: [REGION],
    env,
  });
  assert.equal(resolved.stage, cap.OFFLINE_SEARCH_STAGE.DISABLED);
  assert.equal(resolved.reason, 'off');
});

test('fail closed: an absent or malformed config resolves as disabled, never ready', () => {
  for (const config of [
    undefined,
    {},
    { offline: {} },
    { offline: { search: null } },
    { offline: { search: 'junk' } },
    { offline: { search: { enabled: 'true' } } }, // truthy string is not enabled:true
  ]) {
    const resolved = cap.resolveOfflineSearchCapability({ config, regions: [REGION], env });
    assert.equal(resolved.stage, cap.OFFLINE_SEARCH_STAGE.DISABLED, JSON.stringify(config));
    assert.equal(resolved.enabled, false);
  }
});

test('a region is eligible only when it is complete and plans tiles', () => {
  assert.equal(cap.isEligibleRegion(REGION), true);
  assert.equal(cap.isEligibleRegion({ ...REGION, status: 'downloading' }), false);
  assert.equal(cap.isEligibleRegion({ ...REGION, artifacts: [{ kind: 'index', format: 'x' }] }), false);
  assert.equal(cap.isEligibleRegion({ ...REGION, artifacts: [] }), false);
  assert.equal(cap.isEligibleRegion(null), false);
});

test('an incomplete region yields no_regions rather than a partial ready', () => {
  const resolved = cap.resolveOfflineSearchCapability({
    config: ready,
    regions: [{ ...REGION, status: 'interrupted' }],
    env,
  });
  assert.equal(resolved.stage, cap.OFFLINE_SEARCH_STAGE.NO_REGIONS);
});

test('the typed unavailable error carries the reason and code', () => {
  const err = new cap.OfflineSearchUnavailableError('no_regions');
  assert.equal(err.code, 'offline_unavailable');
  assert.equal(err.reason, 'no_regions');
  assert.equal(err.name, 'OfflineSearchUnavailableError');
});

test('the server resolver reports the operator switch independently of the download gate', () => {
  const { resolveOfflineSearchConfig } = require('../offline/search-config');
  const resolved = resolveOfflineSearchConfig();
  // Default is on, and it never carries the B2 download blocker: searching
  // stored regions is device-local and does not depend on download rights.
  assert.deepEqual(resolved, { enabled: true, blocker: null, reason: null });
});
