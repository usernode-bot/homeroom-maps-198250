// Live traffic (Phase 12D) — the server-facing configuration resolver.
//
// Combines three inputs into the one effective capability the app reports:
//
//   1. the live-traffic provider permission gate (traffic/provider-policy.js).
//      T1 is currently closed: no traffic provider is chosen, no terms are
//      accepted, no credential exists, and docs/traffic-provider-rights.md
//      does not exist. Creating that document — not flipping a switch — is
//      what opens the gate.
//   2. the operator switch TRAFFIC_ENABLED (config.js). It can only narrow,
//      never widen, the permission gate.
//   3. the provider registry (traffic/provider.js), which is EMPTY: no
//      traffic adapter is implemented, so no adapter can be configured and
//      the capability can never resolve true today.
//
// server.js reports the result through the EXISTING public /api/config
// response: map.capabilities.traffic, features.traffic and the `traffic`
// block. When the gate is closed the block carries blocker 'T1' and the
// reason, and the client shows the honest unavailable state — an unavailable
// source is an honest absence, never a guess.
'use strict';

const { TRAFFIC_ENABLED } = require('../config');
const { resolveTrafficProviderRights } = require('./provider-policy');
const { getProvider } = require('./provider');

// The master spec's 12D refresh default (docs/wave-5-master-spec.md, item 13).
// Only read when a provider is actually enabled, which cannot happen yet.
const DEFAULT_REFRESH_MS = 120000;

function resolveTrafficConfig({
  providerName = String(process.env.TRAFFIC_PROVIDER || '').trim().toLowerCase(),
  operatorEnabled = TRAFFIC_ENABLED,
  // Dependency-injected for tests, like the gate's own read: the real call
  // reads the repository's docs directory.
  docPath,
  readFileSync,
} = {}) {
  const rights = resolveTrafficProviderRights(providerName, { docPath, readFileSync });
  // The registry is empty today, so this is always null — but the check is
  // written in full so a future adapter cannot enable the feature by merely
  // registering: it must ALSO be configured (its key declared) on top of the
  // gate and the switch.
  let provider = null;
  try {
    provider = getProvider(providerName);
  } catch {
    provider = null;
  }
  const adapterReady = Boolean(
    provider && typeof provider.isConfigured === 'function' && provider.isConfigured(),
  );

  // One effective boolean: the provider is documented AND configured AND the
  // operator has not turned the feature off. There is no path to `true` that
  // skips the documentation gate.
  const enabled = Boolean(operatorEnabled) && rights.permitted && adapterReady;

  return {
    enabled,
    blocker: enabled ? null : rights.blocker || 'T1',
    reason: enabled
      ? null
      : Boolean(operatorEnabled)
        ? rights.reason ||
          (adapterReady
            ? 'The live-traffic permission gate is closed.'
            : 'The provider is documented and permitted, but no configured traffic adapter is available, so there is no live source to connect to.')
        : 'Live traffic is turned off by the operator switch. The permission gate (T1) is unaffected.',
    provider: enabled && provider ? provider.name : null,
    refreshMs: enabled ? parseRefreshMs() : null,
  };
}

function parseRefreshMs() {
  const parsed = Number.parseInt(process.env.TRAFFIC_REFRESH_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_MS;
}

module.exports = { resolveTrafficConfig, DEFAULT_REFRESH_MS };
