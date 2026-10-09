// Offline search server-side configuration (Phase 12B).
//
// A small resolver for the `offline.search` block reported through the
// EXISTING public /api/config response, kept in its own file so Phase 12A's
// offline/index.js is not modified (the non-modification list freezes it).
//
// This is an OPERATOR switch only. It deliberately does NOT fold in the B2
// tile-provider download gate: searching regions a device has already
// downloaded is a device-local read with no provider traffic, so it is
// available even while downloads are closed.
'use strict';

const { OFFLINE_SEARCH_ENABLED } = require('../config');

function resolveOfflineSearchConfig() {
  const enabled = Boolean(OFFLINE_SEARCH_ENABLED);
  return {
    enabled,
    blocker: enabled ? null : 'operator',
    reason: enabled
      ? null
      : 'Offline search is turned off by the operator switch. Online search is unaffected.',
  };
}

module.exports = { resolveOfflineSearchConfig };
