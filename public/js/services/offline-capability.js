// Offline capability — the pure gate every Phase 12A surface keys on.
//
// Resolves the EFFECTIVE offline capability from two inputs:
//
//   - the server's public config (`/api/config`'s `offline` block), which
//     already folds in the tile-provider permission gate (B2) and the
//     operator switch,
//   - the device's actual support (service worker, IndexedDB, storage
//     estimate), injectable for tests.
//
// The output is a stage, never a promise of a feature:
//
//   ready                downloads permitted and the device can store them
//   provider_blocked     the permission gate is closed (blocker 'B2' today)
//   unsupported_browser  service worker or IndexedDB missing on this device
//
// While the stage is not `ready` nothing in the UI may render a download
// affordance, and the service worker registration is not requested (see
// offline-registration.js). The gate is fail-closed: an absent or malformed
// config resolves as blocked, never as ready.
'use strict';

export const OFFLINE_STAGE = {
  READY: 'ready',
  PROVIDER_BLOCKED: 'provider_blocked',
  UNSUPPORTED_BROWSER: 'unsupported_browser',
};

// True when this browser can hold offline regions at all. Guarded so the
// same module stays importable in Node (tests) where the globals are absent.
function deviceSupport(overrides = {}) {
  const has = (value, fallback) => (value === undefined ? fallback : value);
  const scope = typeof globalThis !== 'undefined' ? globalThis : {};
  return {
    serviceWorker: has(overrides.serviceWorker, Boolean(scope.navigator && scope.navigator.serviceWorker)),
    indexedDB: has(overrides.indexedDB, Boolean(scope.indexedDB)),
    storageEstimate: has(overrides.storageEstimate, Boolean(scope.navigator && scope.navigator.storage && typeof scope.navigator.storage.estimate === 'function')),
  };
}

export function resolveOfflineCapability({ config, env } = {}) {
  const offlineConfig = (config && config.offline) || null;
  const support = deviceSupport(env);
  const maxStorageBytes = (offlineConfig && offlineConfig.maxStorageBytes) || 0;

  // A device without the storage primitives cannot hold a region, whatever
  // the server says. Honest device state before anything else.
  if (!support.serviceWorker || !support.indexedDB) {
    return {
      stage: OFFLINE_STAGE.UNSUPPORTED_BROWSER,
      downloadsEnabled: false,
      swRequired: false,
      blocker: null,
      reason: null,
      maxStorageBytes,
      presets: [],
      support,
    };
  }

  // Fail closed: no config block, no downloads entry, or a disabled one all
  // resolve as blocked. The blocker code comes from the server ('B2' while
  // the repository documents no tile-provider download rights).
  if (!offlineConfig || !offlineConfig.downloads || offlineConfig.downloads.enabled !== true) {
    return {
      stage: OFFLINE_STAGE.PROVIDER_BLOCKED,
      downloadsEnabled: false,
      swRequired: false,
      blocker: (offlineConfig && offlineConfig.downloads && offlineConfig.downloads.blocker) || 'B2',
      reason: (offlineConfig && offlineConfig.downloads && offlineConfig.downloads.reason) || null,
      maxStorageBytes,
      presets: [],
      support,
    };
  }

  return {
    stage: OFFLINE_STAGE.READY,
    downloadsEnabled: true,
    // The service worker is required only once downloads are real: it is the
    // offline-serving path for the stored region's tiles.
    swRequired: true,
    blocker: null,
    reason: null,
    maxStorageBytes,
    presets: Array.isArray(offlineConfig.presets) ? offlineConfig.presets : [],
    support,
  };
}