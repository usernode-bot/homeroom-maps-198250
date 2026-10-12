// Resolves the weather capability the server reports in /api/config
// (Phase 12G). The pure sibling of offline/search-config.js: no I/O beyond
// the W1 rights-document read inside the gate, and no provider-specific
// knowledge.
//
// The contract: `configured` is true only when a weather adapter is BOTH
// registered, configured and authorized under the W1 gate. Today the
// registry is empty, so the answer is always
//   { configured: false, provider: null, blocker: 'W1', reason: ... }
// and the client renders the honest "Weather unavailable" state. When an
// authorized adapter ships, this flips to configured without any client
// change — the panel's states already cover the configured world.
'use strict';

const { capability } = require('./index');

function resolveWeatherConfig() {
  return capability();
}

module.exports = { resolveWeatherConfig };
