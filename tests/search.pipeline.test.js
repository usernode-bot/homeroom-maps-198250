// Tests for the search pipeline itself (search/index.js run()): cache hit
// path, dedupe, param parsing, and every typed refusal — driven with stub
// providers registered under test names so no test touches the network.
// Each test file runs in its own node:test process, so the shared token
// bucket starts full for this file.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../search');
const { register } = require('../search/provider');

// One normalized-shaped result (normalizeResult's output shape).
function res(id, name) {
  return {
    id,
    kind: 'city',
    name,
    localName: null,
    detail: name,
    address: {},
    addressLine: null,
    lat: 1,
    lon: 2,
    provider: 'stub',
  };
}

// A configurable adapter that records its calls and returns fixed results.
function stubProvider(name, { results = [], public: isPublic = false, supportsSuggest = true, isConfigured = () => true } = {}) {
  const calls = [];
  const record = (mode) => async (params) => {
    calls.push({ mode, ...params });
    return results;
  };
  const adapter = {
    name,
    public: isPublic,
    supportsSuggest,
    isConfigured,
    suggest: record('suggest'),
    search: record('search'),
  };
  adapter.calls = calls;
  return adapter;
}

test('run returns adapter results, then serves the same query from cache', async () => {
  const stub = stubProvider('pipe-cache', { results: [res('c1', 'Cachedville')] });
  register(stub);
  const params = { q: 'cacheable query', limit: '5' };
  const first = await run('search', params, {}, { providerName: 'pipe-cache' });
  assert.equal(first.cached, false);
  assert.equal(first.provider, 'pipe-cache');
  assert.deepEqual(first.results.map((r) => r.id), ['c1']);
  const second = await run('search', params, {}, { providerName: 'pipe-cache' });
  assert.equal(second.cached, true);
  assert.deepEqual(second.results.map((r) => r.id), ['c1']);
  assert.equal(stub.calls.length, 1); // the provider was hit once
});

test('run collapses duplicate ids, keeping the first occurrence', async () => {
  const stub = stubProvider('pipe-dedupe', {
    results: [res('d1', 'First'), res('d1', 'Dup'), res('d2', 'Second')],
  });
  register(stub);
  const out = await run('suggest', { q: 'dedupe me' }, {}, { providerName: 'pipe-dedupe' });
  assert.deepEqual(out.results.map((r) => r.id), ['d1', 'd2']);
  assert.equal(out.results[0].name, 'First');
});

test('run parses bbox, near, radius and limit before the adapter sees them', async () => {
  const stub = stubProvider('pipe-params');
  register(stub);
  await run(
    'search',
    { q: 'params', bbox: '1,2,3,4', near: '5,6', radius: '7', limit: '3' },
    {},
    { providerName: 'pipe-params' },
  );
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0], {
    mode: 'search',
    q: 'params',
    limit: 3,
    bbox: [1, 2, 3, 4],
    near: { lat: 5, lon: 6, radiusKm: 7 },
    lang: null,
  });
});

test('run refuses an unknown provider with not_configured', async () => {
  await assert.rejects(
    () => run('search', { q: 'x' }, {}, { providerName: 'no-such-provider' }),
    (e) => e.code === 'not_configured',
  );
});

test('run refuses suggest for a provider without suggestion support', async () => {
  const stub = stubProvider('pipe-nosuggest', { supportsSuggest: false });
  register(stub);
  await assert.rejects(
    () => run('suggest', { q: 'ber' }, {}, { providerName: 'pipe-nosuggest' }),
    (e) => e.code === 'not_configured',
  );
  assert.equal(stub.calls.length, 0); // nothing reached the adapter
});

test('run refuses an unconfigured provider with not_configured', async () => {
  const stub = stubProvider('pipe-unconfigured', { isConfigured: () => false });
  register(stub);
  await assert.rejects(
    () => run('search', { q: 'x' }, {}, { providerName: 'pipe-unconfigured' }),
    (e) => e.code === 'not_configured',
  );
  assert.equal(stub.calls.length, 0);
});

test('run rejects an unknown mode with invalid_query', async () => {
  await assert.rejects(
    () => run('nonsense', { q: 'x' }, {}, { providerName: 'pipe-cache' }),
    (e) => e.code === 'invalid_query',
  );
});

test('run enforces the shared bucket for public providers with rate_limited', async () => {
  const stub = stubProvider('pipe-throttled', { results: [res('t1', 'T')], public: true });
  register(stub);
  // Drain whatever tokens remain (unique queries dodge the cache), then
  // confirm the typed error the client surfaces as "Search is busy".
  let limited = null;
  for (let i = 0; i < 10 && !limited; i++) {
    try {
      await run('search', { q: `drain-${i}` }, {}, { providerName: 'pipe-throttled' });
    } catch (err) {
      limited = err.code === 'rate_limited' ? err : null;
    }
  }
  assert.ok(limited, 'expected a rate_limited error once the bucket is drained');
  assert.equal(limited.message, 'Search is busy right now. Try again in a moment.');
});