// Tests for the routing pipeline (routing/index.js run()): validation order,
// capability gating, rate limiting, the cache, and every typed refusal —
// driven with stub providers registered under test names so no test touches
// the network.
//
// The module-level token bucket is shared by every call in this process, so
// all stubs here register `public: false` except the dedicated rate-limit
// test, which runs LAST and drains the (initially full) bucket itself.
// Unique coordinate pairs per test keep the module-level route cache from
// bridging test cases.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, resolveRoutingConfig } = require('../routing/index');
const { register } = require('../routing/provider');

// A configurable routing adapter that records its calls and returns fixed
// normalized-shaped routes.
function stubProvider(name, { routes = [], modes = ['driving'], configured = true, public: isPublic = false } = {}) {
  const calls = [];
  const adapter = {
    name,
    label: name.toUpperCase(),
    attribution: 'OpenStreetMap',
    public: isPublic,
    isConfigured: () => configured,
    capabilities: {
      modes,
      alternatives: true,
      waypoints: true,
      steps: true,
      traffic: false,
      restrictions: false,
      transit: false,
    },
    async route(request) {
      calls.push(request);
      if (typeof routes === 'function') return routes(request);
      return routes.map((r) => ({ ...r, provider: name }));
    },
  };
  adapter.calls = calls;
  return adapter;
}

// Unique endpoint pairs so no test's answer ever lands in another's cache slot.
function params(tag) {
  return {
    origin: `${tag}.1,${tag}.2`,
    destination: `${tag}.3,${tag}.4`,
  };
}

const ROUTE = (dist) => ({ geometry: [[1, 2], [3, 4]], distance: dist, duration: 60, legs: [] });

test('run validates and routes through the named provider, returning normalized routes', async () => {
  const stub = stubProvider('rpipe-basic', { routes: [ROUTE(1000)] });
  register(stub);
  const out = await run(params('1'), { providerName: 'rpipe-basic' });
  assert.equal(out.provider, 'rpipe-basic');
  assert.equal(out.mode, 'driving'); // absent mode defaults to driving
  assert.equal(out.cached, false);
  assert.deepEqual(out.routes.map((r) => r.distance), [1000]);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0], {
    origin: { lat: 1.1, lon: 1.2 },
    destination: { lat: 1.3, lon: 1.4 },
    waypoints: [],
    mode: 'driving',
  });
});

test('run passes parsed waypoints and the requested mode through to the adapter', async () => {
  const stub = stubProvider('rpipe-waypoints', { modes: ['driving', 'walking'], routes: [ROUTE(10)] });
  register(stub);
  await run(
    { ...params('2'), waypoints: '2.5,2.6|2.7,2.8', mode: 'walking' },
    { providerName: 'rpipe-waypoints' },
  );
  assert.deepEqual(stub.calls[0].waypoints, [{ lat: 2.5, lon: 2.6 }, { lat: 2.7, lon: 2.8 }]);
  assert.equal(stub.calls[0].mode, 'walking');
});

test('run refuses malformed and over-cap requests before any adapter is touched', async () => {
  const stub = stubProvider('rpipe-invalid', {});
  register(stub);
  await assert.rejects(
    () => run({ ...params('3'), origin: 'not-a-point' }, { providerName: 'rpipe-invalid' }),
    (err) => err.code === 'invalid_request',
  );
  await assert.rejects(
    () => run({ ...params('3'), destination: '99,200' }, { providerName: 'rpipe-invalid' }),
    (err) => err.code === 'invalid_request',
  );
  await assert.rejects(
    () => run({ ...params('3'), mode: 'teleport' }, { providerName: 'rpipe-invalid' }),
    (err) => err.code === 'invalid_request',
  );
  await assert.rejects(
    () => run({ ...params('3'), waypoints: '1,1|2,2|3,3|4,4|5,5|6,6' }, { providerName: 'rpipe-invalid' }),
    (err) => err.code === 'invalid_request',
  );
  assert.equal(stub.calls.length, 0);
});

test('run refuses a mode the configured provider does not serve with unsupported_mode', async () => {
  const stub = stubProvider('rpipe-caps', { modes: ['driving'] });
  register(stub);
  await assert.rejects(
    () => run({ ...params('4'), mode: 'transit' }, { providerName: 'rpipe-caps' }),
    (err) => err.code === 'unsupported_mode',
  );
  assert.equal(stub.calls.length, 0); // never reached the engine
});

test('run reports an unconfigured provider with not_configured', async () => {
  const stub = stubProvider('rpipe-unconf', { configured: false });
  register(stub);
  await assert.rejects(
    () => run(params('5'), { providerName: 'rpipe-unconf' }),
    (err) => err.code === 'not_configured',
  );
  assert.equal(stub.calls.length, 0);
});

test('run refuses an unknown provider name with not_configured', async () => {
  await assert.rejects(
    () => run(params('6'), { providerName: 'rpipe-nonexistent' }),
    (err) => err.code === 'not_configured',
  );
});

test('run serves a repeat route from cache without touching the provider again', async () => {
  const stub = stubProvider('rpipe-cache', { routes: [ROUTE(2000)] });
  register(stub);
  const p = params('7');
  const first = await run(p, { providerName: 'rpipe-cache' });
  assert.equal(first.cached, false);
  const second = await run(p, { providerName: 'rpipe-cache' });
  assert.equal(second.cached, true);
  assert.deepEqual(second.routes.map((r) => r.distance), [2000]);
  assert.equal(stub.calls.length, 1);
});

test('cache keys include the mode and waypoints, so a different request is a fresh call', async () => {
  const stub = stubProvider('rpipe-keying', { routes: [ROUTE(30)] });
  register(stub);
  const a = await run({ ...params('8'), mode: 'driving' }, { providerName: 'rpipe-keying' });
  const b = await run({ ...params('8'), mode: 'driving', waypoints: '8.5,8.6' }, { providerName: 'rpipe-keying' });
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
  assert.equal(stub.calls.length, 2);
});

test('resolveRoutingConfig prints the configured provider and its capabilities', () => {
  const config = resolveRoutingConfig();
  // In the test process the real OSRM adapter registers from config defaults
  // (keyless), so the platform's own provider answers; whichever adapter is
  // configured, the shape is stable and nothing sensitive is exposed.
  assert.equal(typeof config.configured, 'boolean');
  assert.ok(Array.isArray(config.modes));
  assert.ok(typeof config.capabilities.alternatives === 'boolean');
  assert.ok(typeof config.capabilities.waypoints === 'boolean');
  assert.ok(!('apiKey' in config) && !('token' in config));
});

// LAST: the shared bucket starts full in this process and only a public
// provider consumes it, so drain it exactly here.
test('run rate-limits a PUBLIC provider beyond the shared burst budget', async () => {
  const stub = stubProvider('rpipe-public', { routes: [ROUTE(40)], public: true });
  register(stub);
  // Five unique requests (distinct cache keys) drain the full bucket.
  for (let i = 0; i < 5; i++) {
    await run({ origin: `9.${i},9.${i}`, destination: `9.${i + 1},9.${i + 1}` }, { providerName: 'rpipe-public' });
  }
  assert.equal(stub.calls.length, 5);
  await assert.rejects(
    () => run({ origin: '9.9,9.9', destination: '9.99,9.99' }, { providerName: 'rpipe-public' }),
    (err) => err.code === 'rate_limited',
  );
  assert.equal(stub.calls.length, 5); // the refused request never reached the engine
});
