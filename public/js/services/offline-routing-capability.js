// Offline routing capability — the pure gate the Directions offline states
// key on (Phase 12C).
//
// It answers one question: can this device calculate a route from the areas
// it already holds, without a network? It folds together:
//
//   - the operator switch (the server's `offline.routing` block),
//   - real device support (IndexedDB present — the tile store's medium),
//   - what is actually stored (at least one complete region with tiles),
//   - whether a verified routing engine ships in this build at all.
//
// That last input is the honest one this build carries. Phase 12A's B2
// provider-rights gate is closed, so no real region has ever been
// downloadable, and the only tile bytes in the repository are the synthetic
// `place`-layer fixture. The downloaded tile format's `transportation` layer
// therefore cannot be verified to carry routable road data (named edges,
// connectivity, oneway/access/speed), so the Dijkstra/A* engine the Phase
// 12C spec plans is NOT implemented in this build: a graph built against
// unverified data would fabricate road connectivity. ENGINE_AVAILABLE is the
// single flip point for the future change that ships a verified engine over
// a verified data contract; until then no code path can produce an offline
// route.
//
// The output is a stage:
//
//   ready                flag on, IndexedDB present, an eligible region
//                        exists, and a verified engine ships
//   unavailable          everything on this device is ready except the
//                        engine: this build cannot route offline yet
//   no_regions           flag on and IndexedDB present, but nothing stored
//   unsupported_browser  this device cannot hold offline data at all
//   disabled             the operator turned offline routing off (default)
//
// Fail closed: an absent or malformed `offline.routing` block resolves as
// `disabled`, never as `ready`. The resolver never throws, and every input
// is injectable (config, indexedDB, the region list, the engine switch) so
// node:test can drive the whole matrix without a browser.
'use strict';

// The same eligibility rule offline search uses: a complete RegionManifest
// v1 that actually stores tiles. Reused, not re-implemented, so the two
// offline capabilities can never disagree about what a region is.
import { isEligibleRegion } from './offline-search-capability.js';

export const OFFLINE_ROUTING_STAGE = {
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  NO_REGIONS: 'no_regions',
  UNSUPPORTED_BROWSER: 'unsupported_browser',
  DISABLED: 'disabled',
};

// See the module comment. `false` is a statement about this build, not a
// config value: no environment variable reaches it.
export const ENGINE_AVAILABLE = false;

// True when this device can hold offline data at all. Guarded so the module
// stays importable in Node (tests) where the globals are absent.
function deviceSupport(overrides = {}) {
  const has = (value, fallback) => (value === undefined ? fallback : value);
  const scope = typeof globalThis !== 'undefined' ? globalThis : {};
  return { indexedDB: has(overrides.indexedDB, Boolean(scope.indexedDB)) };
}

export function resolveOfflineRoutingCapability({
  config,
  regions = [],
  env = {},
  engineAvailable = ENGINE_AVAILABLE,
} = {}) {
  const routing = config && config.offline && config.offline.routing;
  const support = deviceSupport(env);

  // Fail closed first: an absent or malformed block (or an explicit
  // enabled:false) is the operator switch being off. Routing offline is off
  // by default in this build, so an absent block is the expected shape.
  if (!routing || typeof routing !== 'object' || routing.enabled !== true) {
    return {
      stage: OFFLINE_ROUTING_STAGE.DISABLED,
      enabled: false,
      engineAvailable: false,
      reason: (routing && routing.reason) || null,
      blocker: (routing && routing.blocker) || null,
      support,
      regions: [],
    };
  }

  if (!support.indexedDB) {
    return {
      stage: OFFLINE_ROUTING_STAGE.UNSUPPORTED_BROWSER,
      enabled: true,
      engineAvailable: false,
      reason: null,
      blocker: null,
      support,
      regions: [],
    };
  }

  // The same eligibility rule offline search uses: a complete RegionManifest
  // v1 that actually stores tiles. Reused, not re-implemented, so the two
  // offline capabilities can never disagree about what a region is.
  const list = Array.isArray(regions) ? regions : [];
  const eligible = list.filter(isEligibleRegion);
  if (!eligible.length) {
    return {
      stage: OFFLINE_ROUTING_STAGE.NO_REGIONS,
      enabled: true,
      engineAvailable: false,
      reason: null,
      blocker: null,
      support,
      regions: [],
    };
  }

  if (!engineAvailable) {
    return {
      stage: OFFLINE_ROUTING_STAGE.UNAVAILABLE,
      enabled: true,
      engineAvailable: false,
      reason: null,
      blocker: null,
      support,
      regions: eligible,
    };
  }

  return {
    stage: OFFLINE_ROUTING_STAGE.READY,
    enabled: true,
    engineAvailable: true,
    reason: null,
    blocker: null,
    support,
    regions: eligible,
  };
}