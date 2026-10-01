// Tests for the routing provider adapters (routing/providers/). The OSRM
// adapter is driven with an injectable fetch implementation — no test touches
// the network — and the placeholder adapters are checked for their honest
// not_configured behaviour.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOsrm } = require('../routing/providers/osrm');
const { createValhalla } = require('../routing/providers/valhalla');
const { createGraphhopper } = require('../routing/providers/graphhopper');

// An OSRM-shaped JSON response.
function osrmBody(code, routes) {
  return { json: async () => ({ code, routes }) };
}

function okFetch(body) {
  return async () => ({ ok: true, status: 200, ...body });
}

async function rejectCode(fn) {
  try {
    await fn();
  } catch (err) {
    return err.code;
  }
  return 'no-throw';
}

const REQUEST = {
  origin: { lat: 52.52, lon: 13.405 },
  destination: { lat: 48.13, lon: 11.58 },
  waypoints: [],
  mode: 'driving',
};

// ── URL construction ───────────────────────────────────────────────────────

test('OSRM adapter builds the route URL: profile per mode, lon/lat order, alternatives+steps+geojson', async () => {
  let seen = null;
  const fetchImpl = async (url) => {
    seen = url;
    return osrmBody('Ok', []); // routes empty -> no_route below, URL is what we check
  };
  const osrm = createOsrm({
    url: 'https://osrm.example',
    profiles: { driving: 'car', cycling: 'bike' },
    fetchImpl,
  });
  await rejectCode(() => osrm.route(REQUEST)); // capture the URL even on refusal
  assert.ok(seen.startsWith('https://osrm.example/route/v1/car/13.405,52.52;11.58,48.13'), seen);
  assert.ok(seen.includes('alternatives=true'));
  assert.ok(seen.includes('steps=true'));
  assert.ok(seen.includes('overview=simplified'));
  assert.ok(seen.includes('geometries=geojson'));

  await rejectCode(() => osrm.route({ ...REQUEST, mode: 'cycling', waypoints: [{ lat: 50, lon: 8 }] }));
  assert.ok(seen.startsWith('https://osrm.example/route/v1/bike/13.405,52.52;8,50;11.58,48.13'), seen);
});

test('OSRM capabilities are honest: modes from profiles, no traffic, no transit', () => {
  const osrm = createOsrm({ url: 'https://osrm.example', profiles: { driving: 'car' } });
  assert.deepEqual(osrm.capabilities.modes, ['driving']);
  assert.equal(osrm.capabilities.alternatives, true);
  assert.equal(osrm.capabilities.waypoints, true);
  assert.equal(osrm.capabilities.steps, true);
  assert.equal(osrm.capabilities.traffic, false);
  assert.equal(osrm.capabilities.restrictions, false);
  assert.equal(osrm.capabilities.transit, false);
  assert.equal(osrm.isConfigured(), true);
  assert.equal(osrm.public, true);
  assert.equal(osrm.name, 'osrm');
});

// ── response normalization ─────────────────────────────────────────────────

test('OSRM adapter normalizes an Ok response into RouteResults with road names from steps', async () => {
  const body = okFetch({
    json: async () => ({
      code: 'Ok',
      routes: [
        {
          distance: 1234,
          duration: 600,
          geometry: { coordinates: [[13.405, 52.52], [13.5, 52.6]] },
          legs: [
            {
              distance: 1234,
              duration: 600,
              steps: [
                { name: 'Unter den Linden', distance: 1000, duration: 500, maneuver: { type: 'depart', location: [13.405, 52.52] } },
                { name: 'A 100', distance: 234, duration: 100, maneuver: { type: 'turn', modifier: 'left', location: [13.5, 52.6] } },
              ],
            },
          ],
        },
        {
          // A second route with no geometry: dropped, not fabricated.
          distance: 100,
          duration: 100,
        },
      ],
    }),
  });
  const osrm = createOsrm({ url: 'https://osrm.example', profiles: { driving: 'car' }, fetchImpl: body });
  const routes = await osrm.route(REQUEST);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].geometry, [[13.405, 52.52], [13.5, 52.6]]);
  assert.equal(routes[0].distance, 1234);
  assert.equal(routes[0].duration, 600);
  assert.deepEqual(routes[0].roadInformation, ['Unter den Linden', 'A 100']);
  assert.deepEqual(routes[0].restrictions, []); // OSRM surfaces none: honest empty
  assert.equal(routes[0].provider, 'osrm');
  assert.equal(routes[0].legs[0].steps[0].maneuver.type, 'depart');
});

test('OSRM adapter refuses an all-unusable answer with no_route, never a fabricated route', async () => {
  const osrm = createOsrm({
    url: 'https://osrm.example',
    profiles: { driving: 'car' },
    fetchImpl: okFetch({ json: async () => ({ code: 'Ok', routes: [{}, {}] }) }),
  });
  assert.equal(await rejectCode(() => osrm.route(REQUEST)), 'no_route');
});

// ── provider code mapping ──────────────────────────────────────────────────

test('OSRM codes map to typed errors: NoRoute/NoSegment -> no_route, InvalidQuery -> invalid_request', async () => {
  const withBody = (code) =>
    createOsrm({ url: 'https://osrm.example', profiles: { driving: 'car' }, fetchImpl: okFetch({ json: async () => ({ code }) }) });
  assert.equal(await rejectCode(() => withBody('NoRoute').route(REQUEST)), 'no_route');
  assert.equal(await rejectCode(() => withBody('NoSegment').route(REQUEST)), 'no_route');
  assert.equal(await rejectCode(() => withBody('InvalidQuery').route(REQUEST)), 'invalid_request');
  assert.equal(await rejectCode(() => withBody('InvalidUrl').route(REQUEST)), 'invalid_request');
  assert.equal(await rejectCode(() => withBody('SomethingElse').route(REQUEST)), 'provider_error');
});

// ── transport failures ─────────────────────────────────────────────────────

test('OSRM transport failures are typed: timeout, unreachable, upstream status, unreadable body', async () => {
  const base = { url: 'https://osrm.example', profiles: { driving: 'car' } };

  const timeoutErr = new Error('timed out');
  timeoutErr.name = 'TimeoutError';
  assert.equal(
    await rejectCode(() => createOsrm({ ...base, fetchImpl: async () => { throw timeoutErr; } }).route(REQUEST)),
    'timeout',
  );

  assert.equal(
    await rejectCode(() => createOsrm({ ...base, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }).route(REQUEST)),
    'provider_error',
  );

  assert.equal(
    await rejectCode(() => createOsrm({ ...base, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }).route(REQUEST)),
    'provider_error',
  );

  const unreadable = createOsrm({
    ...base,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  assert.equal(await rejectCode(() => unreadable.route(REQUEST)), 'provider_error');
});

// ── construction guards ────────────────────────────────────────────────────

test('createOsrm refuses to build without a URL or profiles', () => {
  assert.throws(() => createOsrm({}));
  assert.throws(() => createOsrm({ url: 'https://osrm.example', profiles: {} }));
});

// ── placeholder adapters ───────────────────────────────────────────────────

test('Valhalla and GraphHopper are honest placeholders: unconfigured, refusing with their setup instructions', async () => {
  const valhalla = createValhalla();
  assert.equal(valhalla.isConfigured(), false);
  assert.equal(await rejectCode(() => valhalla.route(REQUEST)), 'not_configured');
  const valhallaErr = (() => {
    try {
      valhalla.route(REQUEST);
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.match(valhallaErr.message, /Valhalla/);

  const graphhopper = createGraphhopper();
  assert.equal(graphhopper.isConfigured(), false);
  assert.equal(await rejectCode(() => graphhopper.route(REQUEST)), 'not_configured');
  const graphhopperErr = (() => {
    try {
      graphhopper.route(REQUEST);
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.match(graphhopperErr.message, /GRAPHHOPPER_API_KEY/);
});
