// The offline capability gate (Phase 12A): the pure resolver every surface
// keys on. Fail-closed by construction — an absent, malformed or disabled
// config block resolves as blocked, never as ready.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let resolveOfflineCapability;
let OFFLINE_STAGE;

test.before(async () => {
  ({ resolveOfflineCapability, OFFLINE_STAGE } = await import(
    '../public/js/services/offline-capability.js'
  ));
});

const SUPPORTED_ENV = { serviceWorker: true, indexedDB: true, storageEstimate: true };

function blockedConfig(blocker = 'B2') {
  return {
    map: { provider: 'maplibre-openfreemap' },
    offline: {
      offline: false,
      downloads: { enabled: false, blocker, reason: 'no documented rights' },
      maxStorageBytes: 2048 * 1024 * 1024,
      presets: [],
    },
  };
}

function readyConfig() {
  return {
    map: { provider: 'maplibre-openfreemap', styleUrl: 'https://tiles.example/styles/liberty' },
    offline: {
      offline: true,
      downloads: { enabled: true, blocker: null, reason: null },
      maxStorageBytes: 1024 * 1024,
      presets: [{ id: 'jakarta', name: 'Jakarta', bounds: {}, zoom: { min: 10, max: 14 } }],
    },
  };
}

test('the three stages exist and a supported device with a ready config resolves ready', () => {
  assert.deepEqual(Object.values(OFFLINE_STAGE).sort(), ['provider_blocked', 'ready', 'unsupported_browser']);
  const capability = resolveOfflineCapability({ config: readyConfig(), env: SUPPORTED_ENV });
  assert.equal(capability.stage, OFFLINE_STAGE.READY);
  assert.equal(capability.downloadsEnabled, true);
  assert.equal(capability.swRequired, true);
  assert.equal(capability.blocker, null);
  assert.equal(capability.presets.length, 1);
  assert.equal(capability.maxStorageBytes, 1024 * 1024);
});

test('a missing config block resolves blocked, not ready', () => {
  for (const config of [null, undefined, {}, { map: {} }]) {
    const capability = resolveOfflineCapability({ config, env: SUPPORTED_ENV });
    assert.equal(capability.stage, OFFLINE_STAGE.PROVIDER_BLOCKED);
    assert.equal(capability.downloadsEnabled, false);
    assert.equal(capability.blocker, 'B2');
    assert.deepEqual(capability.presets, []);
  }
});

test('a disabled downloads block resolves blocked with the server blocker', () => {
  const capability = resolveOfflineCapability({ config: blockedConfig(), env: SUPPORTED_ENV });
  assert.equal(capability.stage, OFFLINE_STAGE.PROVIDER_BLOCKED);
  assert.equal(capability.blocker, 'B2');
  assert.ok(capability.reason);
  assert.equal(capability.presets.length, 0);
});

test('a device without service worker or IndexedDB resolves unsupported before anything else', () => {
  const cases = [{ serviceWorker: false, indexedDB: true }, { serviceWorker: true, indexedDB: false }];
  for (const env of cases) {
    const capability = resolveOfflineCapability({ config: readyConfig(), env });
    assert.equal(capability.stage, OFFLINE_STAGE.UNSUPPORTED_BROWSER);
    assert.equal(capability.downloadsEnabled, false);
    // Even unsupported, presets are never offered.
    assert.deepEqual(capability.presets, []);
  }
});

test('the gate is fail-closed against a malformed downloads block', () => {
  const configs = [
    { offline: {} },
    { offline: { downloads: null } },
    { offline: { downloads: { enabled: 'yes' } } },
    { offline: { downloads: { enabled: 1 } } },
  ];
  for (const config of configs) {
    const capability = resolveOfflineCapability({ config, env: SUPPORTED_ENV });
    assert.equal(capability.stage, OFFLINE_STAGE.PROVIDER_BLOCKED, JSON.stringify(config));
  }
});

test('the injected env decides device support, not the test host globals', () => {
  const withEnv = resolveOfflineCapability({ config: readyConfig(), env: { serviceWorker: false, indexedDB: false } });
  assert.equal(withEnv.stage, OFFLINE_STAGE.UNSUPPORTED_BROWSER);
});