// Unit tests for the search provider adapters, with fetch injected so no
// test touches the network. The mocks use each provider's documented
// response shape; the never-invent-results invariant is asserted directly.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhoton } = require('../search/providers/photon');
const { createNominatim } = require('../search/providers/nominatim');
const { createPelias } = require('../search/providers/pelias');
const { createMapbox } = require('../search/providers/mapbox');
const { createGoogle } = require('../search/providers/google');
const { createHere } = require('../search/providers/here');

// Minimal fetch Response stand-in.
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

// Collects called URLs and returns them; responds with the queued bodies.
function fetchingMock(responses = []) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const next = queue.shift();
    if (typeof next === 'function') return next(url, opts);
    if (next) return next;
    return jsonResponse({ features: [] });
  };
  impl.calls = calls;
  return impl;
}

// ---- Photon ----

test('photon suggest builds the documented URL and passes supported langs only', async () => {
  const impl = fetchingMock();
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  await adapter.suggest({ q: 'münchen', limit: 5, lang: 'de-AT', bbox: null, near: null });
  assert.equal(impl.calls.length, 1);
  const url = new URL(impl.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://photon.test/api');
  assert.equal(url.searchParams.get('q'), 'münchen');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('lang'), 'de');
});

test('photon drops unsupported language codes instead of erroring', async () => {
  const impl = fetchingMock();
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  await adapter.suggest({ q: 'ber', limit: 5, lang: 'pt-BR', bbox: null, near: null });
  const url = new URL(impl.calls[0].url);
  assert.equal(url.searchParams.get('lang'), null);
});

test('photon search mode carries bbox and near; suggest mode does not', async () => {
  const impl = fetchingMock();
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  const bbox = [13.30, 52.45, 13.45, 52.56];
  const near = { lat: 48.86, lon: 2.35, radiusKm: 5 };
  await adapter.search({ q: 'cafe', limit: 8, bbox, near, lang: null });
  await adapter.suggest({ q: 'cafe', limit: 8, bbox, near, lang: null });
  const searchUrl = new URL(impl.calls[0].url);
  assert.equal(searchUrl.searchParams.get('bbox'), '13.3,52.45,13.45,52.56');
  assert.equal(searchUrl.searchParams.get('lat'), '48.86');
  assert.equal(searchUrl.searchParams.get('lon'), '2.35');
  const suggestUrl = new URL(impl.calls[1].url);
  assert.equal(suggestUrl.searchParams.get('bbox'), null);
  assert.equal(suggestUrl.searchParams.get('lat'), null);
});

// A feature shaped exactly like a real Photon answer (city).
const PHOTON_CITY = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [13.395, 52.517] },
  properties: {
    osm_type: 'R', osm_id: 240109189, osm_key: 'place', osm_value: 'city',
    name: 'Berlin', country: 'Deutschland', countrycode: 'DE', state: 'Berlin',
    city: 'Berlin',
  },
};

test('photon features normalize into the normalized result shape', async () => {
  const impl = fetchingMock([jsonResponse({ type: 'FeatureCollection', features: [PHOTON_CITY] })]);
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  const results = await adapter.suggest({ q: 'berlin', limit: 1, lang: null, bbox: null, near: null });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.id, 'photon:osm.relation.240109189');
  assert.equal(r.kind, 'city');
  assert.equal(r.name, 'Berlin');
  assert.equal(r.detail, 'City, Berlin, Deutschland');
  assert.equal(r.lon, 13.395);
  assert.equal(r.lat, 52.517);
  assert.equal(r.provider, 'photon');
  assert.deepEqual(Object.keys(r).sort(), [
    'address', 'addressLine', 'detail', 'id', 'kind', 'lat', 'localName',
    'lon', 'name', 'provider',
  ].sort());
  assert.deepEqual(r.address.countryCode, 'DE');
});

test('photon maps categories to kinds: street, poi, landmark, address, other', async () => {
  const feature = (key, value, name) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { osm_key: key, osm_value: value, name, country: 'X' },
  });
  const impl = fetchingMock([jsonResponse({
    type: 'FeatureCollection',
    features: [
      feature('highway', 'residential', 'Hauptstraße'),
      feature('amenity', 'cafe', 'Cafe A'),
      feature('historic', 'castle', 'Schloss'),
      feature('building', 'yes', 'Haus 1'),
      feature('weird', 'thing', 'Oddity'),
    ],
  })]);
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  const results = await adapter.search({ q: 'x', limit: 5, bbox: null, near: null, lang: null });
  assert.deepEqual(results.map((r) => r.kind), ['street', 'poi', 'landmark', 'address', 'other']);
});

test('photon passes an empty provider answer through as an empty array', async () => {
  const impl = fetchingMock([jsonResponse({ type: 'FeatureCollection', features: [] })]);
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  const results = await adapter.suggest({ q: 'xzqqqjjj', limit: 8, bbox: null, near: null });
  assert.deepEqual(results, []);
});

test('photon maps upstream failures to provider_error', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: fetchingMock([jsonResponse({}, { ok: false, status: 500 })]),
  });
  await assert.rejects(
    () => adapter.search({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) => e.code === 'provider_error',
  );
});

test('photon maps upstream 429 to provider_error (client sees its own rate limit separately)', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: fetchingMock([jsonResponse({}, { ok: false, status: 429 })]),
  });
  await assert.rejects(
    () => adapter.search({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) => e.code === 'provider_error',
  );
});

test('photon maps an aborted or timed-out request to provider_error', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  await assert.rejects(
    () => adapter.suggest({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) => e.code === 'provider_error',
  );
});

test('photon skips features without a usable name or coordinates', async () => {
  const impl = fetchingMock([jsonResponse({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { coordinates: [0, 0] }, properties: { name: '' } },
      { type: 'Feature', geometry: { coordinates: [] }, properties: { name: 'No coords' } },
      PHOTON_CITY,
    ],
  })]);
  const adapter = createPhoton({ url: 'https://photon.test', fetchImpl: impl });
  const results = await adapter.search({ q: 'x', limit: 5, bbox: null, near: null });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Berlin');
});

// ---- Nominatim ----

test('nominatim search maps bbox into viewbox left,top,right,bottom with bounded=1', async () => {
  const impl = fetchingMock([jsonResponse([])]);
  const adapter = createNominatim({ url: 'https://nominatim.test', fetchImpl: impl });
  await adapter.search({ q: 'berlin', limit: 5, bbox: [13.30, 52.45, 13.45, 52.56], lang: 'de' });
  const url = new URL(impl.calls[0].url);
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  assert.equal(url.searchParams.get('addressdetails'), '1');
  assert.equal(url.searchParams.get('namedetails'), '1');
  // Nominatim's own ordering: minLon, maxLat, maxLon, minLat.
  assert.equal(url.searchParams.get('viewbox'), '13.3,52.56,13.45,52.45');
  assert.equal(url.searchParams.get('bounded'), '1');
  assert.equal(impl.calls[0].opts.headers['Accept-Language'], 'de');
  // The usage policy requires an identifying User-Agent.
  assert.match(impl.calls[0].opts.headers['User-Agent'], /HomeroomMaps/);
});

test('nominatim suggest is refused as not_configured (policy forbids autocomplete)', async () => {
  const impl = fetchingMock();
  const adapter = createNominatim({ url: 'https://nominatim.test', fetchImpl: impl });
  assert.equal(adapter.supportsSuggest, false);
  await assert.rejects(
    async () => adapter.suggest({ q: 'ber', limit: 5 }),
    (e) => e.code === 'not_configured',
  );
  assert.equal(impl.calls.length, 0); // nothing was sent
});

test('nominatim normalizes namedetails, address and display_name', async () => {
  const impl = fetchingMock([jsonResponse([{
    place_id: 123,
    osm_type: 'relation',
    osm_id: 62422,
    category: 'place',
    type: 'city',
    addresstype: 'city',
    name: 'Munich',
    display_name: 'Munich, Bavaria, Germany',
    namedetails: { name: 'München', 'name:en': 'Munich' },
    address: { city: 'Munich', state: 'Bavaria', country: 'Germany', country_code: 'de' },
    lat: '48.137',
    lon: '11.575',
  }])]);
  const adapter = createNominatim({ url: 'https://nominatim.test', fetchImpl: impl });
  const results = await adapter.search({ q: 'munich', limit: 1, bbox: null, lang: 'en' });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.name, 'Munich');
  assert.equal(r.localName, 'München');
  assert.equal(r.kind, 'city');
  assert.equal(r.detail, 'City, Munich, Bavaria, Germany');
  assert.equal(r.addressLine, 'Munich, Bavaria, Germany');
  assert.equal(r.address.countryCode, 'de');
  assert.equal(r.provider, 'nominatim');
});

// ---- Pelias ----

test('pelias is not configured without a URL and configured with one', () => {
  assert.equal(createPelias({ url: '' }).isConfigured(), false);
  assert.equal(createPelias({ url: 'https://pelias.test' }).isConfigured(), true);
});

test('pelias builds autocomplete/search URLs with focus and boundary params', async () => {
  const impl = fetchingMock();
  const adapter = createPelias({ url: 'https://pelias.test', apiKey: 'k-test', fetchImpl: impl });
  await adapter.suggest({ q: 'ber', limit: 5, lang: 'en', bbox: null, near: { lat: 48.86, lon: 2.35, radiusKm: 5 } });
  await adapter.search({ q: 'berlin', limit: 10, lang: 'en', bbox: [13.3, 52.45, 13.45, 52.56], near: null });
  const suggestUrl = new URL(impl.calls[0].url);
  assert.equal(suggestUrl.pathname, '/v1/autocomplete');
  assert.equal(suggestUrl.searchParams.get('api_key'), 'k-test');
  assert.equal(suggestUrl.searchParams.get('focus.point.lat'), '48.86');
  assert.equal(suggestUrl.searchParams.get('boundary.circle.radius'), '5');
  const searchUrl = new URL(impl.calls[1].url);
  assert.equal(searchUrl.pathname, '/v1/search');
  assert.equal(searchUrl.searchParams.get('boundary.rect.min_lon'), '13.3');
  assert.equal(searchUrl.searchParams.get('boundary.rect.max_lat'), '52.56');
});

test('pelias picks the requested language name and keeps the default as localName', async () => {
  const impl = fetchingMock([jsonResponse({
    features: [{
      type: 'Feature',
      geometry: { coordinates: [13.395, 52.517] },
      properties: {
        id: 'whosonfirst:locality:123', layer: 'locality',
        name: { default: 'Berlin', de: 'Berlin', en: 'Berlin' },
        country: 'Germany', locality: 'Berlin',
      },
    }],
  })]);
  const adapter = createPelias({ url: 'https://pelias.test', fetchImpl: impl });
  const results = await adapter.search({ q: 'berlin', limit: 5, lang: 'ja', bbox: null, near: null });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Berlin'); // no ja name: falls back to default
  assert.equal(results[0].localName, null); // same string: not repeated
  const jp = fetchingMock([jsonResponse({
    features: [{
      type: 'Feature',
      geometry: { coordinates: [139.81, 35.71] },
      properties: {
        id: 'whosonfirst:locality:456', layer: 'locality',
        name: { default: '錦糸町', en: 'Kinshicho' },
        country: 'Japan', locality: '錦糸町',
      },
    }],
  })]);
  const adapter2 = createPelias({ url: 'https://pelias.test', fetchImpl: jp });
  const results2 = await adapter2.search({ q: 'kinshicho', limit: 5, lang: 'en', bbox: null, near: null });
  assert.equal(results2[0].name, 'Kinshicho');
  assert.equal(results2[0].localName, '錦糸町');
});

// ---- PLACEHOLDER adapters ----

test('placeholder adapters are unconfigured and never touch the network', async () => {
  for (const create of [createMapbox, createGoogle, createHere]) {
    const adapter = create();
    assert.equal(adapter.isConfigured(), false);
    await assert.rejects(
      async () => adapter.suggest({ q: 'ber', limit: 5 }),
      (e) => e.code === 'not_configured',
    );
    await assert.rejects(
      async () => adapter.search({ q: 'berlin', limit: 10 }),
      (e) => e.code === 'not_configured',
    );
  }
});

// ---- shared requestJson error mapping ----
//
// Photon stands in for every implemented adapter: the fetch/timeout/status/
// parse mapping lives in one place (search/provider.js requestJson) and the
// messages flow to the client unchanged.

test('an upstream 429 is reported honestly as throttling', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: fetchingMock([jsonResponse({}, { ok: false, status: 429 })]),
  });
  await assert.rejects(
    () => adapter.search({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) =>
      e.code === 'provider_error' &&
      e.message === 'The search provider is throttling requests right now.',
  );
});

test('a timed-out request maps to the did-not-answer-in-time message', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  await assert.rejects(
    () => adapter.suggest({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) => e.code === 'provider_error' && e.message === 'The search provider did not answer in time.',
  );
});

test('an unreachable provider maps to the could-not-be-reached message', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(
    () => adapter.search({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) => e.code === 'provider_error' && e.message === 'The search provider could not be reached.',
  );
});

test('an unreadable body maps to the unreadable-answer message', async () => {
  const adapter = createPhoton({
    url: 'https://photon.test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      },
    }),
  });
  await assert.rejects(
    () => adapter.suggest({ q: 'x', limit: 5, bbox: null, near: null }),
    (e) => e.code === 'provider_error' && e.message === 'The search provider sent an unreadable answer.',
  );
});