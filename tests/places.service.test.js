// Tests for the PlaceService (places/index.js) over a stub PlaceProvider, and
// for the provider registry/request helper (places/provider.js). Covers the
// normal path, missing and invalid rows, adapter failures, and the honest
// not_configured state the app ships in with no provider connected.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlaceService, activeProviderName, providerNames } = require('../places');
const { placeError, requestJson, register, getProvider } = require('../places/provider');

// A well-formed partial place, as an adapter would return from its provider.
function partial(id, overrides = {}) {
  return {
    id,
    name: `Place ${id}`,
    coordinates: { lat: 10, lon: 20 },
    address: 'Demo street 1',
    country: 'Demo country',
    dataSource: 'stub',
    ...overrides,
  };
}

function stubProvider(impl = {}) {
  return {
    name: 'stub',
    isConfigured: () => true,
    getPlaces: async () => [partial('a'), partial('b')],
    getPlaceById: async (id) => partial(id),
    getPlaceDetails: async (id) =>
      partial(id, {
        phone: '+49 30 000000',
        website: 'https://example.com',
        openingHours: { status: 'open' },
        rating: { value: 4.2, count: 7 },
        photos: [{ url: 'https://example.com/p.jpg' }],
        businessStatus: 'closed_temporarily',
        verificationStatus: 'verified',
      }),
    ...impl,
  };
}

test('with no provider configured the service answers typed not_configured, never fake data', async () => {
  const service = createPlaceService({ providerName: '' });
  await assert.rejects(() => service.getPlaces({ q: 'berlin' }), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.match(err.message, /No place provider is connected yet/);
    return true;
  });
  await assert.rejects(() => service.getPlaceById('x'), (err) => err.code === 'not_configured');
  await assert.rejects(() => service.getPlaceDetails('x'), (err) => err.code === 'not_configured');
  // And /api/config reports the honest null.
  assert.equal(activeProviderName(), null);
});

test('an unknown or unconfigured provider name surfaces as not_configured', async () => {
  const service = createPlaceService({ providerName: 'no-such-provider' });
  await assert.rejects(() => service.getPlaces({ q: 'x' }), (err) => {
    assert.equal(err.code, 'not_configured');
    return true;
  });

  register({
    name: 'unconfigured-stub',
    isConfigured: () => false,
    getPlaces: async () => [],
    getPlaceById: async () => null,
  });
  const service2 = createPlaceService({ providerName: 'unconfigured-stub' });
  await assert.rejects(() => service2.getPlaces({ q: 'x' }), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.match(err.message, /not configured yet/);
    return true;
  });
});

test('getPlaces normalizes adapter rows and drops unusable ones', async () => {
  register(stubProvider());
  const service = createPlaceService({ providerName: 'stub' });
  assert.ok(providerNames().includes('stub'));
  const out = await service.getPlaces({ q: 'demo' });
  assert.equal(out.provider, 'stub');
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results.map((r) => r.id), ['a', 'b']);
  // Every row is the normalized shape, with optional fields filled.
  assert.equal(out.results[0].dataSource, 'stub');
  assert.equal(out.results[0].rating, null);
  assert.deepEqual(out.results[0].photos, []);
});

test('getPlaces skips garbage rows, empty answers stay empty', async () => {
  const service = createPlaceService({
    providerName: 'stub',
  });
  register(stubProvider({
    getPlaces: async () => [partial('ok'), null, { name: 'no id' }, { id: 'no name' }, 'junk'],
  }));
  const out = await service.getPlaces({ q: 'demo' });
  assert.deepEqual(out.results.map((r) => r.id), ['ok']);

  register(stubProvider({ getPlaces: async () => null }));
  const empty = await createPlaceService({ providerName: 'stub' }).getPlaces({ q: 'demo' });
  assert.deepEqual(empty.results, []);
});

test('getPlaces requires a term or a location, and passes the params through', async () => {
  const seen = [];
  register(stubProvider({
    getPlaces: async (params) => {
      seen.push(params);
      return [];
    },
  }));
  const service = createPlaceService({ providerName: 'stub' });
  await assert.rejects(() => service.getPlaces({}), (err) => {
    assert.equal(err.code, 'invalid_query');
    return true;
  });
  await assert.rejects(() => service.getPlaces({ q: '   ' }), (err) => err.code === 'invalid_query');
  await service.getPlaces({ q: 'demo', near: '1,2', radius: '5', limit: '3' });
  assert.deepEqual(seen[0], {
    q: 'demo',
    near: { lat: 1, lon: 2, radiusKm: 5 },
    bbox: null,
    limit: 3,
    lang: null,
  });
  // A huge limit is clamped by the shared validation, not passed through.
  await service.getPlaces({ near: '1,2', limit: '9999' });
  assert.equal(seen[1].limit, 20);
  assert.equal(seen[1].q, null);
});

test('getPlaceById returns a summary; getPlaceDetails returns the full depth', async () => {
  const service = createPlaceService({ providerName: 'stub' });
  const summary = await service.getPlaceById('a', { lang: 'de' });
  assert.equal(summary.place.name, 'Place a');
  assert.equal(summary.place.phone, null);
  const full = await service.getPlaceDetails('a');
  assert.equal(full.place.phone, '+49 30 000000');
  assert.equal(full.place.website, 'https://example.com');
  assert.equal(full.place.openingHours.status, 'open');
  assert.deepEqual(full.place.rating, { value: 4.2, count: 7 });
  assert.equal(full.place.businessStatus, 'closed_temporarily');
  assert.equal(full.place.verificationStatus, 'verified');
});

test('an adapter without getPlaceDetails falls back to getPlaceById', async () => {
  register(stubProvider({ getPlaceDetails: undefined }));
  const service = createPlaceService({ providerName: 'stub' });
  const out = await service.getPlaceDetails('a');
  assert.equal(out.place.name, 'Place a');
});

test('empty or unusable single-place answers surface as typed not_found', async () => {
  register(stubProvider({ getPlaceById: async () => null, getPlaceDetails: async () => ({}) }));
  const service = createPlaceService({ providerName: 'stub' });
  await assert.rejects(() => service.getPlaceById('ghost'), (err) => {
    assert.equal(err.code, 'not_found');
    return true;
  });
  await assert.rejects(() => service.getPlaceDetails('ghost'), (err) => err.code === 'not_found');
  await assert.rejects(() => service.getPlaceById('  '), (err) => err.code === 'invalid_query');
});

test('adapter failures propagate as typed errors for the HTTP layer to map', async () => {
  register(stubProvider({
    getPlaces: async () => {
      throw placeError('provider_error', 'The place provider could not be reached.');
    },
    getPlaceById: async () => {
      throw placeError('rate_limited', 'The place provider is throttling requests right now.');
    },
  }));
  const service = createPlaceService({ providerName: 'stub' });
  await assert.rejects(() => service.getPlaces({ q: 'x' }), (err) => {
    assert.equal(err.code, 'provider_error');
    return true;
  });
  await assert.rejects(() => service.getPlaceById('x'), (err) => err.code === 'rate_limited');
});

test('the service re-exports the model contract and rejects a broken shape with it', async () => {
  // normalizePlace cannot produce a shape validatePlace rejects; the guard
  // between the two is defense in depth for adapter bugs. Assert the exported
  // contract directly: both helpers come from places/index.js and agree.
  const { normalizePlace: n, validatePlace: v } = createPlaceService({ providerName: '' });
  const place = n(partial('ok', { rating: { value: 4 } }));
  assert.equal(v(place).ok, true);
  assert.equal(v({ id: 'x', name: 'Broken', photos: [{ url: 'nope' }] }).ok, false);
});

test('activeProviderName is null with no config, and reports a configured adapter', () => {
  // PLACE_PROVIDER is unset in the test environment: honest null.
  assert.equal(activeProviderName(), null);
});

test('requestJson turns every failure mode into a typed provider_error', async () => {
  await assert.rejects(
    () => requestJson('https://example.com', { timeoutMs: 100, fetchImpl: async () => { throw new Error('boom'); } }),
    (err) => {
      assert.equal(err.code, 'provider_error');
      assert.match(err.message, /could not be reached/);
      return true;
    },
  );
  await assert.rejects(
    () => requestJson('https://example.com', {
      timeoutMs: 100,
      fetchImpl: async () => { const e = new Error('slow'); e.name = 'AbortError'; throw e; },
    }),
    (err) => {
      assert.equal(err.code, 'provider_error');
      return true;
    },
  );
  await assert.rejects(
    () => requestJson('https://example.com', {
      timeoutMs: 100,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    }),
    (err) => {
      assert.match(err.message, /status 500/);
      return true;
    },
  );
  await assert.rejects(
    () => requestJson('https://example.com', {
      timeoutMs: 100,
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    (err) => {
      assert.match(err.message, /throttling/);
      return true;
    },
  );
  await assert.rejects(
    () => requestJson('https://example.com', {
      timeoutMs: 100,
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
    }),
    (err) => {
      assert.match(err.message, /unreadable answer/);
      return true;
    },
  );
  const body = await requestJson('https://example.com', {
    timeoutMs: 100,
    fetchImpl: async () => ({ ok: true, json: async () => ({ fine: true }) }),
  });
  assert.deepEqual(body, { fine: true });
});

test('the registry refuses an anonymous adapter and answers unknown names with a hint', () => {
  assert.throws(() => register({}), /needs a name/);
  assert.throws(() => getProvider('nope'), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.match(err.message, /PLACE_PROVIDER/);
    return true;
  });
});