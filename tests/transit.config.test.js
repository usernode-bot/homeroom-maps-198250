// The transit capability resolver (Phase 12E, stage 1): the truth table over
// operator switch, PT1 rights gate and adapter registry. Fail-closed by
// construction — the only way a test reaches `enabled: true` is by injecting
// BOTH a fake rights document AND a fake registered adapter, and every test
// that registers one removes it again, so the shipped registry stays empty
// and the shipped repository state can never resolve as verified.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTransitConfig } = require('../transit/index');
const { transitError, register, getProvider, providerNames, registry } = require('../transit/provider');

const PROVIDER = 'staging-demo-transit';
const MISSING_DOC = '/tmp/phase-12e-no-rights-doc.md';

// A fake rights document with all three markers, built in memory only.
function rightsDoc(provider) {
  return [`provider: ${provider}`, 'transit-feed: permitted', 'evidence: https://example.com/feed-licence'].join('\n');
}

// A fake adapter satisfying the TransitProvider contract. Registered inside a
// test run only, always removed again in `finally`.
function fakeAdapter(name = PROVIDER, { configured = true } = {}) {
  return {
    name,
    label: 'Staging demo transit',
    attribution: 'Staging demo data',
    public: false,
    isConfigured: () => configured,
    capabilities: { stops: true, departures: true, routing: true, alerts: false },
    getStops: async () => [],
    getDepartures: async () => [],
    route: async () => null,
  };
}

test('the provider registry ships empty', () => {
  assert.deepEqual(providerNames(), []);
  assert.equal(registry.size, 0);
});

test('getProvider throws not_configured on a miss and names registered adapters when any exist', () => {
  assert.throws(() => getProvider(PROVIDER), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.match(err.message, /No transit adapter is registered yet/);
    return true;
  });
  try {
    register(fakeAdapter('another-demo-transit'));
    assert.throws(() => getProvider(PROVIDER), (err) => {
      assert.equal(err.code, 'not_configured');
      assert.match(err.message, /Registered adapters: another-demo-transit/);
      return true;
    });
  } finally {
    registry.delete('another-demo-transit');
  }
  assert.deepEqual(providerNames(), []);
});

test('register rejects an adapter without a name or without isConfigured()', () => {
  assert.throws(() => register({ label: 'no name' }), (err) => err.code === 'invalid_request');
  assert.throws(() => register({ name: 'no-is-configured' }), (err) => err.code === 'invalid_request');
  assert.deepEqual(providerNames(), []);
});

test('transitError carries the typed code the HTTP layer maps', () => {
  for (const [code, expected] of [['not_configured', 'not_configured'], ['rate_limited', 'rate_limited'], ['timeout', 'timeout'], ['provider_error', 'provider_error']]) {
    assert.equal(transitError(code, 'message').code, expected);
  }
});

test('with the shipped repository state the resolver reports honest unavailable', () => {
  // No DI at all: the real (absent) docs file and the empty registry decide.
  const config = resolveTransitConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'PT1');
  assert.equal(config.provider, null);
  assert.match(config.reason, /No transit provider is configured/);
});

test('the operator switch can only narrow: off means off, whatever the gate says', () => {
  const options = { providerName: PROVIDER, operatorEnabled: false, docPath: MISSING_DOC };
  const config = resolveTransitConfig(options);
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'PT1');
  assert.match(config.reason, /operator switch is off/);

  // Even with the gate satisfied in-memory, the switch keeps it closed.
  const permitted = resolveTransitConfig({
    providerName: PROVIDER,
    operatorEnabled: false,
    docPath: '/tmp/fake.md',
    readFileSync: () => rightsDoc(PROVIDER),
  });
  assert.equal(permitted.enabled, false);
  assert.match(permitted.reason, /operator switch is off/);
});

test('a configured provider with no rights document stays blocked with the PT1 wording', () => {
  const config = resolveTransitConfig({ providerName: PROVIDER, docPath: MISSING_DOC });
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'PT1');
  assert.match(config.reason, /does not document transit data rights for staging-demo-transit/);
});

test('a rights document for another provider does not enable', () => {
  const config = resolveTransitConfig({
    providerName: PROVIDER,
    docPath: '/tmp/fake.md',
    readFileSync: () => rightsDoc('some-other-provider'),
  });
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'PT1');
  assert.match(config.reason, /does not name the configured provider/);
});

test('a permitted document without a registered adapter reports the adapter gap', () => {
  const config = resolveTransitConfig({
    providerName: PROVIDER,
    docPath: '/tmp/fake.md',
    readFileSync: () => rightsDoc(PROVIDER),
  });
  assert.equal(config.enabled, false);
  assert.equal(config.blocker, 'PT1');
  assert.match(config.reason, /no configured adapter is registered/);
});

test('an aspirational capability flag never enables anything (the valhalla.js trap)', () => {
  // capabilities all true, isConfigured() false — exactly the shipped Valhalla
  // stub's shape. The resolver keys on isConfigured() first.
  try {
    register(fakeAdapter(PROVIDER, { configured: false }));
    const config = resolveTransitConfig({
      providerName: PROVIDER,
      docPath: '/tmp/fake.md',
      readFileSync: () => rightsDoc(PROVIDER),
    });
    assert.equal(config.enabled, false);
    assert.equal(config.blocker, 'PT1');
    assert.match(config.reason, /no configured adapter is registered/);
  } finally {
    registry.delete(PROVIDER);
  }
});

test('a fake rights document and a fake adapter enable the resolver inside a test run only', () => {
  try {
    register(fakeAdapter(PROVIDER));
    const config = resolveTransitConfig({
      providerName: PROVIDER,
      docPath: '/tmp/fake.md',
      readFileSync: () => rightsDoc(PROVIDER),
    });
    assert.equal(config.enabled, true);
    assert.equal(config.blocker, null);
    assert.equal(config.reason, null);
    assert.equal(config.provider, PROVIDER);
  } finally {
    registry.delete(PROVIDER);
  }
});

test('after every test run the shipped registry is empty again', () => {
  assert.deepEqual(providerNames(), []);
  assert.equal(registry.size, 0);
});
