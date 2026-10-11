// The Phase 12D traffic resolver (traffic/index.js) and the honesty contract
// of the Home traffic panel (public/js/services/map.js trafficPanelState).
//
// The through-line of every assertion: unavailable, stale, invalid or absent
// traffic can never resolve as verified live traffic. With the provider
// registry empty — the only reachable state — `enabled` is false no matter
// what the environment says, the panel renders only i18n keys from a fixed
// allowlist, and no code path exists that could emit provider traffic data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTrafficConfig } = require('../traffic/index');
const trafficProviders = require('../traffic/provider');
const { resolveProviderRights } = require('../offline/provider-policy');

const PERMITTED_DOC = [
  '# Traffic provider rights',
  'provider: test-provider',
  'live-traffic-feed: permitted',
  'evidence: https://example.com/terms',
  '',
].join('\n');

const PERMITTED_OPTS = { readFileSync: () => PERMITTED_DOC };

test('with the empty registry the capability is blocked T1 whatever the environment says', () => {
  const config = resolveTrafficConfig({ providerName: 'test-provider', ...PERMITTED_OPTS });
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'T1');
  assert.equal(config.provider, null);
  assert.equal(config.refreshMs, null);
  assert.match(config.reason, /no configured|not configured|configured traffic provider/i);
  assert.deepEqual(trafficProviders.providerNames(), [], 'no traffic adapter ships in this change');
});

test('an unset provider is the honest no-source state, never a guess', () => {
  const config = resolveTrafficConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'T1');
  assert.match(config.reason, /no traffic source to authorize|No live traffic provider is configured/i);
  assert.equal(config.provider, null);
  assert.equal(config.refreshMs, null);
});

test('the operator switch can only narrow: gate open + configured adapter + switch off stays off', () => {
  // Register a fully configured adapter so every OTHER condition holds; the
  // switch alone must keep the capability off.
  trafficProviders.register({
    name: 'test-provider',
    label: 'Test provider',
    attribution: 'Test attribution',
    public: false,
    capabilities: { flow: true, incidents: true, speeds: true },
    isConfigured: () => true,
  });
  try {
    const narrowed = resolveTrafficConfig({
      providerName: 'test-provider',
      operatorEnabled: false,
      ...PERMITTED_OPTS,
    });
    assert.equal(narrowed.enabled, false);
    assert.equal(narrowed.blocker, 'T1');
    assert.match(narrowed.reason, /operator switch/i);
    assert.equal(narrowed.provider, null);
    assert.equal(narrowed.refreshMs, null);
  } finally {
    // Leave the registry as this change ships it: empty.
    trafficProviders.registry.delete('test-provider');
  }
});

test('the switch cannot widen: gate closed stays closed even with the switch on', () => {
  const widened = resolveTrafficConfig({ providerName: 'test-provider', operatorEnabled: true });
  assert.equal(widened.enabled, false);
  assert.equal(widened.blocker, 'T1');
});

test('an adapter that registers but is not configured can never enable the capability', () => {
  trafficProviders.register({
    name: 'test-provider',
    label: 'Test provider',
    attribution: 'Test attribution',
    public: false,
    // The Valhalla trap: an aspirational capability flag on an unconfigured
    // adapter is not a live source.
    capabilities: { flow: true, incidents: true, speeds: true },
    isConfigured: () => false,
  });
  try {
    const config = resolveTrafficConfig({
      providerName: 'test-provider',
      operatorEnabled: true,
      ...PERMITTED_OPTS,
    });
    assert.equal(config.enabled, false);
    assert.equal(config.provider, null);
  } finally {
    trafficProviders.registry.delete('test-provider');
  }
});

test('gate open + configured adapter + switch on is the one path to enabled', () => {
  trafficProviders.register({
    name: 'test-provider',
    label: 'Test provider',
    attribution: 'Test attribution',
    public: false,
    capabilities: { flow: true, incidents: true, speeds: true },
    isConfigured: () => true,
  });
  try {
    const config = resolveTrafficConfig({
      providerName: 'test-provider',
      operatorEnabled: true,
      ...PERMITTED_OPTS,
    });
    assert.equal(config.enabled, true);
    assert.equal(config.blocker, null);
    assert.equal(config.reason, null);
    assert.equal(config.provider, 'test-provider');
    assert.equal(config.refreshMs, 120000, 'the master-spec refresh default');
  } finally {
    trafficProviders.registry.delete('test-provider');
  }
});

test('the shipped registry stays empty: no adapter can answer getProvider', () => {
  assert.deepEqual(trafficProviders.providerNames(), []);
  assert.throws(() => trafficProviders.getProvider('anything'), /not_configured|Unknown traffic provider/);
});

// ---- the routing boundary: no authorized routing adapter exposes traffic ----

test('the configured routing stack still reports no live traffic (regression guard)', () => {
  const routing = require('../routing');
  const config = routing.resolveRoutingConfig();
  assert.equal(config.capabilities.traffic, false);
  // The placeholder adapters keep their honest stub flags untouched.
  const valhalla = require('../routing/providers/valhalla');
  const graphhopper = require('../routing/providers/graphhopper');
  assert.equal(valhalla.createValhalla().isConfigured(), false);
  assert.equal(graphhopper.createGraphhopper().isConfigured(), false);
  // And the offline B2 gate is untouched by this change.
  assert.equal(resolveProviderRights('maplibre-openfreemap').permitted, false);
});

// ---- the Home panel state (browser ESM, imported dynamically) ----

let trafficPanelState = null;
test.before(async () => {
  ({ trafficPanelState } = await import('../public/js/services/map.js'));
});

// Every key trafficPanelState may ever return. The panel renders nothing that
// is not on this list — the structural proof that it cannot render live data.
const PANEL_KEY_ALLOWLIST = new Set([
  'traffic.panelTitle',
  'traffic.panelUnavailable',
  'traffic.panelCommunity',
  'traffic.panelRights',
  'traffic.checkAgain',
  'traffic.state.offline',
  'traffic.state.loading',
  'traffic.state.stale',
  'traffic.state.noCoverage',
  'traffic.state.outage',
  'traffic.state.rateLimited',
  'traffic.state.timeout',
  'traffic.state.authFailed',
]);

test('the panel state is fail-closed: missing, malformed or invalid config is "not connected"', () => {
  const invalid = [null, undefined, {}, { enabled: false }, { enabled: 'yes' }, { enabled: 1 }, 'enabled', [], 42];
  for (const block of invalid) {
    const state = trafficPanelState(block, { online: true });
    assert.equal(state.enabled, false, `${JSON.stringify(block)} must not enable`);
    assert.deepEqual(state.lines, [
      'traffic.panelUnavailable',
      'traffic.panelCommunity',
      'traffic.panelRights',
    ]);
  }
});

test('a fetch failure or offline device adds the offline line but never a live claim', () => {
  const state = trafficPanelState(null, { online: false });
  assert.equal(state.enabled, false);
  assert.deepEqual(state.lines, [
    'traffic.panelUnavailable',
    'traffic.state.offline',
    'traffic.panelCommunity',
    'traffic.panelRights',
  ]);
});

test('the panel output is i18n keys only — no traffic value can pass through it', () => {
  // Even a forged "enabled" block carrying payload-shaped fields yields keys
  // and nothing else: the panel has no channel for traffic values.
  const state = trafficPanelState(
    { enabled: true, provider: 'test', segments: [{ congestion: 'high' }], fetchedAt: '2026-01-01' },
    { online: true },
  );
  assert.equal(typeof state.checkAgain, 'string');
  for (const key of state.lines) {
    assert.ok(PANEL_KEY_ALLOWLIST.has(key), `unexpected panel key: ${key}`);
    assert.ok(key.startsWith('traffic.'), `panel lines must be traffic.* i18n keys, got: ${key}`);
  }
  assert.deepEqual(Object.keys(state).sort(), ['checkAgain', 'enabled', 'lines']);
  // The forged block's data fields never leak into the result.
  assert.ok(!JSON.stringify(state).includes('congestion'));
  assert.ok(!JSON.stringify(state).includes('fetchedAt'));
  assert.ok(!JSON.stringify(state).includes('segments'));
});

test('the enabled branch (unreachable today) drops the not-connected copy only', () => {
  const state = trafficPanelState({ enabled: true }, { online: true });
  assert.equal(state.enabled, true);
  assert.deepEqual(state.lines, ['traffic.panelCommunity']);
});
