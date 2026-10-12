// Offline routing — the offline fallback seam for Directions (Phase 12C).
//
// This module wraps the fetchRoute that createDirectionsSession binds
// (services/routing.js). The online path is untouched: the underlying
// fetcher is called first, always, and its answer is returned as-is. Only
// when it fails for a NETWORK-CLASS reason (or a timeout) does the offline
// attempt run, and that attempt is device-local only — the tile store and
// the server config. `fetch` is never called on it, so an offline attempt
// never leaves the device. Arbitrary HTTP errors (no_route, invalid_request,
// rate_limited, not_configured), authorization failures and aborts never
// reach it: they propagate unchanged.
//
// This build ships no routing engine, and none can be honestly built yet:
// Phase 12A's B2 provider-rights gate is closed, so no real region has ever
// been downloaded, and the `transportation` layer of the tile format is
// unverified for road data (see offline-routing-capability.js). The offline
// attempt therefore resolves the capability stage and, because it cannot
// produce a route, rethrows the ORIGINAL online error — the same behavior
// search.js's answer() has when its offline answer is unavailable. The
// Directions screen then shows its honest network state, exactly as before
// this module existed; the localized offline states render from the screen's
// own pre-check when the device is offline to begin with.
//
// Nothing is ever fabricated: no route, no geometry, no road name, no
// duration. The marked insertion point below is the ONE place a verified
// engine plugs into, in a separately approved change.
'use strict';

import { createTileStore } from './offline-tiles.js';
import { resolveOfflineRoutingCapability } from './offline-routing-capability.js';

// Re-declared verbatim from services/search.js (its isNetworkFailure is
// module-private and that file is protected). ONLY network-class failures
// qualify: not an abort, not any error that carries an HTTP status.
function isNetworkFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false;
  if (err.status && err.status > 0) return false;
  return err.code === 'network_error' || err.name === 'TypeError' || err.name === 'NetworkError';
}

// The failures the offline fallback is permitted for: network-class, or a
// timeout (the provider accepted the request but answered too slowly). An
// HTTP status, an invalid request, an authorization failure or an abort is
// never eligible — the wrapper must not paper over a real provider answer.
export function isFallbackEligible(err) {
  if (isNetworkFailure(err)) return true;
  return Boolean(err) && err.code === 'timeout';
}

// Resolve the offline routing stage for this device right now. Device-local
// only: a tile store read plus the config block, never a fetch. A store that
// cannot be read counts as no regions (fail closed), so this never throws.
// `env` and `store` are injectable so node:test can drive it without a
// browser.
export async function resolveOfflineRoutingStage({ config, store = null, env = {} } = {}) {
  let regions = [];
  try {
    const tileStore = store || createTileStore({});
    regions = (await tileStore.listRegions()) || [];
  } catch {
    regions = [];
  }
  return resolveOfflineRoutingCapability({ config, regions, env });
}

// The seam. `resolveStage` is injectable so node:test can observe the
// fallback rules without a browser or an IndexedDB implementation.
export function wrapFetchRoute(
  fetchRoute,
  { config = null, resolveStage = resolveOfflineRoutingStage } = {},
) {
  return async function offlineAwareFetchRoute(request, options) {
    try {
      return await fetchRoute(request, options);
    } catch (err) {
      if (!isFallbackEligible(err)) throw err;
      // The device-local attempt: resolve the stage (tile store + config,
      // zero network traffic). No routing engine ships in this build, so no
      // route can be produced here — the original error propagates and the
      // Directions screen shows its honest network state, exactly as it did
      // before this wrapper existed.
      //
      // ENGINE INSERTION POINT (a future, separately approved change): when
      // ENGINE_AVAILABLE is true and the stage is ready, build the ephemeral
      // graph for the covering region, route the request over it, and return
      // the OfflineRouteResult. Until then, rethrow.
      await resolveStage({ config });
      throw err;
    }
  };
}
