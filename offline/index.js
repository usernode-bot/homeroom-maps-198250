// Offline maps (Phase 12A) — the server-facing configuration resolver.
//
// Combines three inputs into the one effective capability the app reports:
//
//   1. the tile-provider permission gate (offline/provider-policy.js). B2 is
//      currently closed for OpenFreeMap, the configured default: the
//      repository documents no right to bulk-download or persist its tiles.
//   2. the operator switch OFFLINE_ENABLED and budget OFFLINE_MAX_STORAGE_MB
//      (config.js). These can only narrow, never widen, the permission gate.
//   3. the rectangular preset catalog (offline/region-presets.js), offered
//      only when downloads are actually permitted.
//
// server.js reports the result through the EXISTING public /api/config
// response: map.capabilities.offline, features.offline and the `offline`
// block. When the gate is closed the block carries blocker 'B2' and the
// reason, and presets are withheld — the client then shows the honest
// unavailable state and never renders a download affordance.
'use strict';

const { resolveMapConfig, OFFLINE_ENABLED, OFFLINE_MAX_STORAGE_MB } = require('../config');
const { resolveProviderRights } = require('./provider-policy');
const { presentPresets } = require('./region-presets');

function resolveOfflineConfig({ mapProvider = resolveMapConfig().mapProvider } = {}) {
  const rights = resolveProviderRights(mapProvider);
  // One effective boolean: the map provider is documented AND the operator
  // has not turned the feature off. There is no path to `true` that skips
  // the documentation gate.
  const enabled = Boolean(OFFLINE_ENABLED) && rights.permitted;

  return {
    // The capability every consumer keys on. `offline` answers "can this app
    // offer offline map areas at all", which while B2 is closed is no.
    offline: enabled,
    downloads: {
      enabled,
      blocker: enabled ? null : rights.blocker || 'B2',
      reason: enabled ? null : rights.reason,
    },
    provider: mapProvider,
    maxStorageBytes: OFFLINE_MAX_STORAGE_MB * 1024 * 1024,
    // Presets are geometry the gate has already cleared. Withheld while
    // blocked, so a blocked client cannot even render a download affordance.
    presets: enabled ? presentPresets() : [],
  };
}

module.exports = { resolveOfflineConfig };