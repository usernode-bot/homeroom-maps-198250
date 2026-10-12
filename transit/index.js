// Transit (Phase 12E, stage 1) — the server-facing configuration resolver.
//
// Combines three inputs into the one effective capability the app reports:
//
//   1. the transit-provider permission gate (transit/provider-policy.js). PT1
//      is currently closed: the repository documents no transit data source,
//      no licence and no credential anywhere.
//   2. the operator switch TRANSIT_ENABLED (config.js, a later slice). Like
//      OFFLINE_ENABLED it can only narrow, never widen, the permission gate.
//   3. the adapter registry (transit/provider.js), which ships EMPTY — no
//      adapter exists to register, and none may be invented.
//
// server.js (a later slice) reports the result through the EXISTING public
// /api/config response: the `transit` block, map.capabilities.transit and
// features.transit. While the gate is closed the block carries blocker 'PT1'
// and the reason, and the client shows the honest unavailable state.
//
// Every input is dependency-injectable so tests exercise the full truth table
// — including the enabled path — without touching the repository's real docs
// directory or registering anything permanently. A fake rights document and a
// fake adapter can enable the resolver INSIDE A TEST RUN ONLY: shipped code
// and the shipped repository state can never reach that state, because the
// real gate reads the real (absent) docs file and the real registry is empty.
'use strict';

const { resolveTransitProviderRights } = require('./provider-policy');
const { getProvider } = require('./provider');

function resolveTransitConfig(
  { providerName = '', operatorEnabled = true, docPath, readFileSync } = {},
) {
  const provider = String(providerName || '').trim() || null;
  const rights = resolveTransitProviderRights(providerName, { docPath, readFileSync });
  const operatorOn = Boolean(operatorEnabled);

  // An adapter only counts when it is registered AND genuinely configured.
  // The `capabilities` flags are never trusted on their own — that is the
  // standing valhalla.js trap, where an aspirational `transit: true` sits on
  // an adapter whose isConfigured() is false.
  let adapter = null;
  if (provider && rights.permitted) {
    try {
      const candidate = getProvider(provider);
      adapter = candidate.isConfigured() ? candidate : null;
    } catch {
      adapter = null;
    }
  }

  // One effective boolean: the operator has not turned the feature off AND
  // the rights document permits it AND a configured adapter exists. There is
  // no path to `true` that skips the documentation gate.
  const enabled = operatorOn && rights.permitted && Boolean(adapter);

  // The reason distinguishes the four refusal states the spec names, in this
  // precedence: operator switch, then no provider, then the rights gate, then
  // the missing adapter.
  let reason = null;
  if (!operatorOn) {
    reason = 'The TRANSIT_ENABLED operator switch is off, so transit stays disabled regardless of the rights document.';
  } else if (!provider) {
    reason = rights.reason;
  } else if (!rights.permitted) {
    reason = rights.reason;
  } else if (!adapter) {
    reason =
      `The rights document permits ${provider}, but no configured adapter is registered under that name.`;
  }

  return {
    // The capability every consumer keys on. `enabled` answers "can this app
    // offer transit data at all", which while PT1 is closed is no.
    enabled,
    blocker: enabled ? null : 'PT1',
    reason,
    provider,
  };
}

module.exports = { resolveTransitConfig };
