// Offline routing operator switch (Phase 12C) — the server-side resolver
// behind /api/config's `offline.routing` block. Mirrors offline/search-config.js.
//
// Offline routing stays OFF unless the operator explicitly turns it on, and
// turning it on does not by itself make routes appear: the build still ships
// no routing engine (the B2 provider-rights gate is closed and the tile
// format's transportation layer is unverified for road data — see
// public/js/services/offline-routing-capability.js). Online routing is
// unaffected either way.
'use strict';

const { OFFLINE_ROUTING_ENABLED } = require('../config');

function resolveOfflineRoutingConfig() {
  const enabled = Boolean(OFFLINE_ROUTING_ENABLED);
  return {
    enabled,
    blocker: enabled ? null : 'operator',
    reason: enabled
      ? null
      : 'Offline routing is turned off by the operator switch. Online routing is unaffected.',
  };
}

module.exports = { resolveOfflineRoutingConfig };
