// Offline search capability — the pure gate the offline search surfaces key
// on (Phase 12B).
//
// It answers one question: can this device search the places it already holds
// without a network? Unlike the Phase 12A download gate, it does NOT depend on
// the tile-provider permission gate (B2): searching regions already on the
// device is a device-local read, so it is available even while downloads are
// closed. It folds together:
//
//   - the operator switch (the server's `offline.search` block),
//   - real device support (IndexedDB present),
//   - what is actually stored (at least one complete region with tiles).
//
// The output is a stage:
//
//   ready                flag on, IndexedDB present, an eligible region exists
//   no_regions           flag on and IndexedDB present, but nothing to search
//   unsupported_browser  this device cannot hold offline data at all
//   disabled             the operator turned offline search off
//
// Fail closed: an absent or malformed `offline.search` block resolves as
// `disabled`, never as `ready`. The resolver never throws, and every input is
// injectable (config, indexedDB, the region list) so node:test can drive the
// whole matrix without a browser.

export const OFFLINE_SEARCH_STAGE = {
  READY: 'ready',
  NO_REGIONS: 'no_regions',
  UNSUPPORTED_BROWSER: 'unsupported_browser',
  DISABLED: 'disabled',
};

// The typed error the service throws when it cannot answer. It carries a
// `reason` matching one of the non-ready stages, so the panel can pick the
// right copy instead of showing a generic failure.
export class OfflineSearchUnavailableError extends Error {
  constructor(reason = 'no_regions', message) {
    super(message || defaultUnavailableMessage(reason));
    this.name = 'OfflineSearchUnavailableError';
    this.code = 'offline_unavailable';
    this.reason = reason;
  }
}

function defaultUnavailableMessage(reason) {
  if (reason === OFFLINE_SEARCH_STAGE.UNSUPPORTED_BROWSER) {
    return 'This browser cannot search offline areas.';
  }
  if (reason === OFFLINE_SEARCH_STAGE.DISABLED) {
    return 'Offline search is turned off.';
  }
  return 'No offline areas are available on this device.';
}

// True when this device can hold offline data at all. Guarded so the module
// stays importable in Node (tests) where the globals are absent.
function deviceSupport(overrides = {}) {
  const has = (value, fallback) => (value === undefined ? fallback : value);
  const scope = typeof globalThis !== 'undefined' ? globalThis : {};
  return { indexedDB: has(overrides.indexedDB, Boolean(scope.indexedDB)) };
}

// One stored record is eligible when it is a complete RegionManifest v1 that
// plans a `tiles` artifact. Malformed records are skipped (fail closed) rather
// than partially trusted.
export function isEligibleRegion(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.status !== 'complete') return false;
  if (!Array.isArray(record.artifacts)) return false;
  return record.artifacts.some((artifact) => artifact && artifact.kind === 'tiles');
}

export function resolveOfflineSearchCapability({ config, regions = [], env = {} } = {}) {
  const search = config && config.offline && config.offline.search;
  const support = deviceSupport(env);

  // Fail closed first: an absent or malformed block (or an explicit
  // enabled:false) is the operator switch being off.
  if (!search || typeof search !== 'object' || search.enabled !== true) {
    return {
      stage: OFFLINE_SEARCH_STAGE.DISABLED,
      enabled: false,
      reason: (search && search.reason) || null,
      blocker: (search && search.blocker) || null,
      support,
      regions: [],
    };
  }

  if (!support.indexedDB) {
    return {
      stage: OFFLINE_SEARCH_STAGE.UNSUPPORTED_BROWSER,
      enabled: false,
      reason: null,
      blocker: null,
      support,
      regions: [],
    };
  }

  const list = Array.isArray(regions) ? regions : [];
  const eligible = list.filter(isEligibleRegion);
  if (!eligible.length) {
    return {
      stage: OFFLINE_SEARCH_STAGE.NO_REGIONS,
      enabled: false,
      reason: null,
      blocker: null,
      support,
      regions: [],
    };
  }

  return {
    stage: OFFLINE_SEARCH_STAGE.READY,
    enabled: true,
    reason: null,
    blocker: null,
    support,
    regions: eligible,
  };
}
