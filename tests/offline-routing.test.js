// Tests for the Phase 12C offline routing capability stub:
// public/js/services/offline-routing-capability.js (the gate) and
// public/js/services/offline-routing.js (the fallback seam).
//
// SYNTHETIC FIXTURES ONLY. No real offline region has ever been downloaded
// (the B2 provider-rights gate is closed), and no routing engine ships in
// this build, so everything here runs against synthetic region records and
// stub fetchers. These tests verify the gate, the fallback trigger rules and
// the zero-network property of the seam. They never verify real road data
// and never exercise real routing: no route, geometry or duration is
// produced anywhere in this file, matching what the shipped code can do.
//
// The modules are browser ESM but import-safe in Node (no window/document at
// module scope), so they load via dynamic import like the other suites.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let OFFLINE_ROUTING_STAGE;
let ENGINE_AVAILABLE;
let resolveOfflineRoutingCapability;
let isFallbackEligible;
let resolveOfflineRoutingStage;
let wrapFetchRoute;

test.before(async () => {
  const capability = await import('../public/js/services/offline-routing-capability.js');
  const service = await import('../public/js/services/offline-routing.js');
  ({
    OFFLINE_ROUTING_STAGE,
    ENGINE_AVAILABLE,
    resolveOfflineRoutingCapability,
  } = capability);
  ({ isFallbackEligible, resolveOfflineRoutingStage, wrapFetchRoute } = service);
});

// ── synthetic region records ──────────────────────────────────────────────
// Shaped like RegionManifest v1, as offline-search-capability.isEligibleRegion
// reads them. Obviously synthetic names per the staging-mock rules.
const ELIGIBLE_REGION = {
  version: 1,
  id: 'synthetic-region-1',
  name: 'Synthetic test region',
  provider: 'synthetic',
  bounds: { west: 0, south: 0, east: 1, north: 1 },
  zoom: { min: 10, max: 12 },
  artifacts: [{ kind: 'tiles', format: 'mvt', status: 'complete', tileCount: 4 }],
  status: 'complete',
};

const ENABLED_CONFIG = { offline: { routing: { enabled: true } } };
const DEFAULT_CONFIG = { offline: { routing: { enabled: false } } };
const ABSENT_CONFIG = {};
const NODE_SUPPORT = { indexedDB: {} }; // "the device can hold offline data"

// ── the capability gate ──────────────────────────────────────────────────

test('gate: absent config block fails closed to disabled', () => {
  const result = resolveOfflineRoutingCapability({ config: ABSENT_CONFIG });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.DISABLED);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.regions, []);
});

test('gate: malformed config block fails closed to disabled', () => {
  for (const bad of [null, { offline: null }, { offline: {} }, { offline: { routing: 'yes' } }]) {
    const result = resolveOfflineRoutingCapability({ config: bad });
    assert.equal(result.stage, OFFLINE_ROUTING_STAGE.DISABLED, JSON.stringify(bad));
  }
});

test('gate: explicit enabled:false resolves disabled', () => {
  const result = resolveOfflineRoutingCapability({ config: DEFAULT_CONFIG, env: NODE_SUPPORT });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.DISABLED);
});

test('gate: enabled without device support resolves unsupported_browser', () => {
  const result = resolveOfflineRoutingCapability({ config: ENABLED_CONFIG, env: {} });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.UNSUPPORTED_BROWSER);
});

test('gate: enabled with support but no stored regions resolves no_regions', () => {
  const result = resolveOfflineRoutingCapability({
    config: ENABLED_CONFIG,
    regions: [],
    env: NODE_SUPPORT,
  });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.NO_REGIONS);
});

test('gate: non-eligible region records are skipped, not partially trusted', () => {
  const notEligible = [
    null,
    { id: 'draft', status: 'draft' },
    { id: 'no-tiles', status: 'complete', artifacts: [{ kind: 'style', status: 'complete' }] },
  ];
  const result = resolveOfflineRoutingCapability({
    config: ENABLED_CONFIG,
    regions: notEligible,
    env: NODE_SUPPORT,
  });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.NO_REGIONS);
});

test('gate: an eligible region in this build resolves unavailable, never ready', () => {
  const result = resolveOfflineRoutingCapability({
    config: ENABLED_CONFIG,
    regions: [ELIGIBLE_REGION],
    env: NODE_SUPPORT,
  });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.UNAVAILABLE);
  assert.equal(result.engineAvailable, false);
  assert.equal(ENGINE_AVAILABLE, false, 'this build ships no routing engine');
});

test('gate: engineAvailable true is the flip point that resolves ready', () => {
  const result = resolveOfflineRoutingCapability({
    config: ENABLED_CONFIG,
    regions: [ELIGIBLE_REGION],
    env: NODE_SUPPORT,
    engineAvailable: true,
  });
  assert.equal(result.stage, OFFLINE_ROUTING_STAGE.READY);
});

// ── the stage resolver ───────────────────────────────────────────────────

test('stage resolver: reads regions from the injected store', async () => {
  const store = { listRegions: async () => [ELIGIBLE_REGION] };
  const stage = await resolveOfflineRoutingStage({
    config: ENABLED_CONFIG,
    store,
    env: NODE_SUPPORT,
  });
  assert.equal(stage.stage, OFFLINE_ROUTING_STAGE.UNAVAILABLE);
  assert.deepEqual(stage.regions, [ELIGIBLE_REGION]);
});

test('stage resolver: a store that throws fails closed to no_regions', async () => {
  const store = { listRegions: async () => { throw new Error('synthetic store failure'); } };
  const stage = await resolveOfflineRoutingStage({
    config: ENABLED_CONFIG,
    store,
    env: NODE_SUPPORT,
  });
  assert.equal(stage.stage, OFFLINE_ROUTING_STAGE.NO_REGIONS);
});

test('stage resolver: default (off) config stays disabled even with a good store', async () => {
  const store = { listRegions: async () => [ELIGIBLE_REGION] };
  const stage = await resolveOfflineRoutingStage({
    config: DEFAULT_CONFIG,
    store,
    env: NODE_SUPPORT,
  });
  assert.equal(stage.stage, OFFLINE_ROUTING_STAGE.DISABLED);
});

test('stage resolver: without device support it fails closed to unsupported_browser', async () => {
  const store = { listRegions: async () => [ELIGIBLE_REGION] };
  const stage = await resolveOfflineRoutingStage({ config: ENABLED_CONFIG, store, env: {} });
  assert.equal(stage.stage, OFFLINE_ROUTING_STAGE.UNSUPPORTED_BROWSER);
});

// ── fallback trigger rules (the seam) ────────────────────────────────────
// A synthetic fetcher stub; `resolveStage` is a spy so the tests observe
// exactly when the offline attempt runs.

function spyStage() {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return OFFLINE_ROUTING_STAGE.NO_REGIONS;
  };
  return { fn, count: () => calls };
}

test('fallback: a successful answer passes through untouched', async () => {
  const answer = [{ distance: 123, duration: 45, geometry: [] }];
  const fetchRoute = async () => answer;
  const wrapped = wrapFetchRoute(fetchRoute, { resolveStage: spyStage().fn });
  const result = await wrapped({ origin: {}, destination: {} }, {});
  assert.equal(result, answer);
});

test('fallback: HTTP errors, invalid requests and auth failures never trigger it', async () => {
  const never = spyStage();
  const cases = [
    { status: 404, code: 'no_route' },
    { status: 400, code: 'invalid_request' },
    { status: 429, code: 'rate_limited' },
    { status: 501, code: 'not_configured' },
    { status: 401, code: 'unauthorized' },
    { status: 403, code: 'forbidden' },
    { status: 500, code: 'provider_error' },
  ];
  for (const cause of cases) {
    const fetchRoute = async () => {
      throw Object.assign(new Error('synthetic provider failure'), cause);
    };
    const wrapped = wrapFetchRoute(fetchRoute, { resolveStage: never.fn });
    // Rethrew the original error object, and the offline attempt never ran.
    let caught = null;
    try {
      await wrapped({}, {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught && caught.code === cause.code, JSON.stringify(cause));
    assert.equal(caught.message, 'synthetic provider failure');
  }
  assert.equal(never.count(), 0, 'offline attempt must not run for HTTP-class errors');
});

test('fallback: aborts never trigger it', async () => {
  const never = spyStage();
  for (const abort of [{ name: 'AbortError' }, { code: 'ABORT_ERR' }]) {
    const fetchRoute = async () => {
      throw Object.assign(new Error('synthetic abort'), abort);
    };
    const wrapped = wrapFetchRoute(fetchRoute, { resolveStage: never.fn });
    await assert.rejects(() => wrapped({}, {}), (err) => err && err.message === 'synthetic abort');
  }
  assert.equal(never.count(), 0, 'offline attempt must not run for aborts');
});

test('fallback: network-class failures and timeouts trigger it, and the ORIGINAL error propagates', async () => {
  for (const cause of [
    { code: 'network_error' },
    { name: 'TypeError' },
    { name: 'NetworkError' },
    { code: 'timeout', status: 504 },
  ]) {
    const spy = spyStage();
    const original = Object.assign(new Error('synthetic failure'), cause);
    const fetchRoute = async () => {
      throw original;
    };
    const wrapped = wrapFetchRoute(fetchRoute, { resolveStage: spy.fn });
    let caught = null;
    try {
      await wrapped({}, {});
    } catch (err) {
      caught = err;
    }
    assert.equal(caught, original, JSON.stringify(cause));
    assert.equal(spy.count(), 1, 'the offline attempt must run once for this failure class');
  }
});

test('fallback: isFallbackEligible matches exactly the permitted failure classes', () => {
  const eligible = [
    { code: 'network_error' },
    { name: 'TypeError' },
    { name: 'NetworkError' },
    { code: 'timeout', status: 504 },
  ];
  const notEligible = [
    null,
    { name: 'AbortError' },
    { code: 'ABORT_ERR' },
    { status: 404, code: 'no_route' },
    { status: 400, code: 'invalid_request' },
    { status: 401 },
    { status: 403 },
    { status: 429, code: 'rate_limited' },
    { code: 'some_other_code' },
  ];
  for (const err of eligible) assert.equal(isFallbackEligible(err), true, JSON.stringify(err));
  for (const err of notEligible) assert.equal(isFallbackEligible(err), false, JSON.stringify(err));
});

test('fallback: the offline attempt makes ZERO network calls', async () => {
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('synthetic network guard: no fetch may happen on the offline path');
  };
  try {
    let underlyingCalls = 0;
    const fetchRoute = async () => {
      underlyingCalls += 1;
      throw Object.assign(new Error('synthetic failure'), { code: 'network_error' });
    };
    const store = { listRegions: async () => [ELIGIBLE_REGION] };
    const wrapped = wrapFetchRoute(fetchRoute, {
      config: ENABLED_CONFIG,
      resolveStage: (opts) => resolveOfflineRoutingStage({ ...opts, store }),
    });
    let caught = null;
    try {
      await wrapped({}, {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught && caught.code === 'network_error');
    assert.equal(underlyingCalls, 1, 'the online fetcher runs once, and only once');
    assert.equal(networkCalls, 0, 'the offline attempt must never call fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});
