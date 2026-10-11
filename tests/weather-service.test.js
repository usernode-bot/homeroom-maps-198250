// Tests for the weather service pipeline (weather/index.js run()) and the
// normalized WeatherCurrent shape — the weather sibling of
// tests/search.pipeline.test.js, driven entirely with stub adapters and
// injectable collaborators, so no test touches the network or a real clock.
// Covered: the shipped empty-registry honesty (501 not_configured for every
// call), the W1 gate refusing an unauthorized name, validation, the cache,
// the politeness bucket, payload-completeness rejection, and the exact
// normalized shape the panel renders.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherService, normalizeCurrent, WEATHER_FIELD_KEYS } = require('../weather');
const { register, weatherError } = require('../weather/provider');
const { resolveWeatherProviderRights } = require('../weather/provider-policy');
const { SearchCache } = require('../search/cache');

const RIGHT = { permitted: true, blocker: null, reason: null, evidence: 'https://example.com/terms' };
const DENIED = {
  permitted: false,
  blocker: 'W1',
  reason: 'The weather-provider rights document does not authorize the provider.',
  evidence: null,
};

// A stub adapter that records its calls and answers with a fixed payload.
function stubProvider(name, { payload, isConfigured = () => true } = {}) {
  const calls = [];
  const adapter = {
    name,
    isConfigured,
    current: async (params) => {
      calls.push(params);
      if (typeof payload === 'function') return payload(params);
      return payload;
    },
  };
  adapter.calls = calls;
  return adapter;
}

const GOOD_PAYLOAD = {
  latitude: 52.5,
  longitude: 13.4,
  temperatureC: 18.4,
  precipitationMmH: 0.2,
  windSpeedMs: 3.5,
  windDirectionDeg: 240,
  condition: 'Partly cloudy',
  observedAt: '2026-10-11T09:30:00.000Z',
  attribution: 'Example Weather',
};

// rights defaults to a granted gate so tests can focus on the pipeline;
// pass `rights: null` to run the REAL gate against the real (absent)
// docs/weather-provider-rights.md — the shipped repository state.
function makeService({ providerName = 'stub-weather', rights = RIGHT, ttlMs, clockNow } = {}) {
  let tick = 0;
  const now = clockNow || (() => tick += 1000);
  const cache = new SearchCache({ maxEntries: 10, now });
  return createWeatherService({
    providerName,
    ttlMs: ttlMs == null ? 60 * 1000 : ttlMs,
    timeoutMs: 1234,
    cache,
    resolveRights: rights === null ? resolveWeatherProviderRights : () => rights,
  });
}

function fullPayload(overrides = {}) {
  return { ...GOOD_PAYLOAD, ...overrides };
}

test('the shipped registry is empty: every call answers the honest not_configured', async () => {
  const service = makeService({ providerName: '', rights: null });
  await assert.rejects(
    () => service.run({ lat: 52.5, lng: 13.4 }),
    (e) => e.code === 'not_configured',
  );
  assert.equal(service.activeProviderName(), null);
  const cap = service.capability();
  assert.equal(cap.configured, false);
  assert.equal(cap.provider, null);
  assert.equal(cap.blocker, 'W1');
  assert.ok(cap.reason && cap.reason.length > 0);
});

test('an unauthorized provider is refused by the W1 gate, before any adapter runs', async () => {
  register(stubProvider('unauthorized-weather', { payload: fullPayload() }));
  const service = makeService({ providerName: 'unauthorized-weather', rights: DENIED });
  await assert.rejects(
    () => service.run({ lat: 52.5, lng: 13.4 }),
    (e) => e.code === 'not_configured' && /rights document/.test(e.message),
  );
  const cap = service.capability();
  assert.equal(cap.configured, false);
  assert.equal(cap.blocker, 'W1');
});

test('an authorized but unconfigured adapter is refused with not_configured', async () => {
  register(stubProvider('unconfigured-weather', { payload: fullPayload(), isConfigured: () => false }));
  const service = makeService({ providerName: 'unconfigured-weather' });
  await assert.rejects(
    () => service.run({ lat: 52.5, lng: 13.4 }),
    (e) => e.code === 'not_configured' && /not configured yet/.test(e.message),
  );
});

test('run rejects an out-of-range or missing coordinate with invalid_request', async () => {
  const service = makeService();
  for (const params of [
    {},
    { lat: 95, lng: 13.4 },
    { lat: 52.5, lng: 200 },
    { lat: 'north', lng: 13.4 },
  ]) {
    await assert.rejects(() => service.run(params), (e) => e.code === 'invalid_request');
  }
});

test('run rejects a malformed lang with invalid_request', async () => {
  const service = makeService();
  await assert.rejects(
    () => service.run({ lat: 52.5, lng: 13.4, lang: 'not a lang;' }),
    (e) => e.code === 'invalid_request',
  );
});

test('run returns the normalized reading, then serves the same point from cache', async () => {
  const stub = stubProvider('cached-weather', { payload: fullPayload() });
  register(stub);
  const service = makeService({ providerName: 'cached-weather' });
  const first = await service.run({ lat: 52.512345, lng: 13.4111, lang: 'id' });
  assert.equal(first.cached, false);
  // The response's provider identity is the adapter's registry name.
  assert.equal(first.provider, 'cached-weather');
  assert.equal(first.attribution, 'Example Weather');
  assert.equal(first.temperatureC, 18.4);
  assert.deepEqual(first.fields, ['temperature', 'precipitation', 'wind']);
  assert.equal(first.observedAtEstimated, false);
  // Coordinates are rounded to 3 decimals before the adapter and the cache
  // key see them, and the injectable timeout reaches the adapter.
  assert.deepEqual(stub.calls[0], { lat: 52.512, lng: 13.411, lang: 'id', timeoutMs: 1234 });
  const second = await service.run({ lat: 52.5124, lng: 13.4114, lang: 'id' });
  assert.equal(second.cached, true);
  assert.equal(stub.calls.length, 1); // the provider was hit once
});

test('the cache honours its TTL via the injected clock', async () => {
  const stub = stubProvider('ttl-weather', { payload: fullPayload() });
  register(stub);
  let nowMs = 1_000_000;
  const service = makeService({ providerName: 'ttl-weather', ttlMs: 60 * 1000, clockNow: () => nowMs });
  await service.run({ lat: 1, lng: 2 });
  nowMs += 30 * 1000;
  const fresh = await service.run({ lat: 1, lng: 2 });
  assert.equal(fresh.cached, true);
  nowMs += 61 * 1000;
  const stale = await service.run({ lat: 1, lng: 2 });
  assert.equal(stale.cached, false);
  assert.equal(stub.calls.length, 2);
});

test('a payload missing its attribution is rejected outright, and cached as nothing', async () => {
  const stub = stubProvider('incomplete-weather', { payload: fullPayload({ attribution: '  ' }) });
  register(stub);
  const service = makeService({ providerName: 'incomplete-weather' });
  await assert.rejects(
    () => service.run({ lat: 1, lng: 2 }),
    (e) => e.code === 'provider_error' && /attribution/.test(e.message),
  );
  // The failed payload was never cached: the next call reaches the adapter.
  await assert.rejects(() => service.run({ lat: 1, lng: 2 }), (e) => e.code === 'provider_error');
  assert.equal(stub.calls.length, 2);
});

test('a payload with no usable weather field is rejected', async () => {
  const stub = stubProvider('empty-weather', {
    payload: fullPayload({ temperatureC: 'warm', precipitationMmH: null, windSpeedMs: undefined }),
  });
  register(stub);
  const service = makeService({ providerName: 'empty-weather' });
  await assert.rejects(
    () => service.run({ lat: 1, lng: 2 }),
    (e) => e.code === 'provider_error' && /usable weather field/.test(e.message),
  );
});

test('a payload with an unreadable observedAt is stamped with the fetch time and flagged', async () => {
  const stub = stubProvider('estimated-weather', { payload: fullPayload({ observedAt: 'yesterday-ish' }) });
  register(stub);
  const service = makeService({ providerName: 'estimated-weather' });
  const out = await service.run({ lat: 1, lng: 2 });
  assert.equal(out.observedAtEstimated, true);
  assert.ok(!Number.isNaN(Date.parse(out.observedAt)));
});

test('a partial payload lists only the fields its provider actually supplied', async () => {
  const stub = stubProvider('partial-weather', {
    payload: fullPayload({ precipitationMmH: null, windSpeedMs: undefined, fields: null }),
  });
  register(stub);
  const service = makeService({ providerName: 'partial-weather' });
  const out = await service.run({ lat: 1, lng: 2 });
  assert.deepEqual(out.fields, ['temperature']);
  assert.equal(out.precipitationMmH, undefined);
  assert.equal(out.windSpeedMs, undefined);
});

test('a full bucket produces rate_limited before the adapter is touched', async () => {
  let drained = null;
  const bucket = {
    tryTake: () => false,
  };
  const stub = stubProvider('throttled-weather', { payload: fullPayload() });
  register(stub);
  const service = createWeatherService({
    providerName: 'throttled-weather',
    cache: new SearchCache({ maxEntries: 10 }),
    bucket,
    resolveRights: () => RIGHT,
  });
  await assert.rejects(
    () => service.run({ lat: 1, lng: 2 }),
    (e) => {
      drained = e;
      return e.code === 'rate_limited';
    },
  );
  assert.equal(drained.message, 'Weather is busy right now. Try again in a moment.');
  assert.equal(stub.calls.length, 0);
});

test('normalizeCurrent rejects the shapes an adapter must never return', () => {
  for (const bad of [null, 'sunny', {}, { attribution: 'X' }, { provider: 'x' }]) {
    assert.throws(() => normalizeCurrent(bad, 'stub-weather', '2026-01-01T00:00:00.000Z'), (e) => e.code === 'provider_error');
  }
});

test('normalizeCurrent stamps a missing observedAt as estimated, and keeps a real one exact', () => {
  const fetchedAt = '2026-10-11T10:00:00.000Z';
  const estimated = normalizeCurrent(
    { attribution: 'A', temperatureC: 1 },
    'stub-weather',
    fetchedAt,
  );
  assert.equal(estimated.observedAt, fetchedAt);
  assert.equal(estimated.observedAtEstimated, true);
  assert.equal(estimated.fields[0], 'temperature');

  const exact = normalizeCurrent(
    { attribution: 'A', observedAt: '2026-10-11T09:00:00Z', temperatureC: 1 },
    'stub-weather',
    fetchedAt,
  );
  assert.equal(exact.observedAt, '2026-10-11T09:00:00.000Z');
  assert.equal(exact.observedAtEstimated, false);
});

test('the declared field-key list is exactly what the panel knows how to render', () => {
  assert.deepEqual(WEATHER_FIELD_KEYS, ['temperature', 'precipitation', 'wind']);
});

test('weatherError builds typed errors the HTTP layer can map', () => {
  const err = weatherError('timeout', 'late');
  assert.equal(err.code, 'timeout');
  assert.equal(err.message, 'late');
});
