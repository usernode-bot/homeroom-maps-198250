// Tests for the client Directions session core (public/js/services/routing-core.js).
// The module is pure, import-free ESM, so node:test drives it directly via a
// dynamic import — the same convention as tests/search-session.test.js.
// Every behavior the spec requires is covered here without a DOM: validation
// order, duplicate-request prevention, stale-response suppression, swap and
// waypoint semantics, capability gating, error mapping, retry, formatting.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

// The module is browser ESM: loaded once via dynamic import inside the file's
// before-hook (no top-level await — this file is CommonJS like the others).
let createDirectionsSession;
let toLocationPoint;
let currentLocationPoint;
let formatDistance;
let formatDuration;
let routeLine;
let geometryBounds;
let kindFromCode;
let routeError;

before(async () => {
  const core = await import('../public/js/services/routing-core.js');
  ({
    createDirectionsSession,
    toLocationPoint,
    currentLocationPoint,
    formatDistance,
    formatDuration,
    routeLine,
    geometryBounds,
    kindFromCode,
    routeError,
  } = core);
});

const ORIGIN = { id: 'o', name: 'Origin', lat: 52.52, lon: 13.405 };
const DEST = { id: 'd', name: 'Destination', lat: 48.13, lon: 11.58 };
const CAPS = { modes: ['driving', 'walking'], alternatives: true, waypoints: true };

// A session with a recording fetcher returning `routes`.
function makeSession({ routes = [route(1)], capabilities = CAPS, mode = null } = {}) {
  const calls = [];
  const fetchRoute = async (request, opts) => {
    calls.push({ request, opts });
    if (typeof routes === 'function') return routes(request, opts);
    return routes;
  };
  const session = createDirectionsSession({ fetchRoute, capabilities, mode });
  session.fetch = fetchRoute;
  session.calls = calls;
  return session;
}

function route(dist, coords = [[1, 2], [3, 4]]) {
  return {
    geometry: coords,
    distance: dist,
    duration: 60,
    summary: null,
    restrictions: [],
    roadInformation: [],
    legs: [],
    provider: 'stub',
  };
}

// ── validation ────────────────────────────────────────────────────────────

test('calculate refuses locally with missing_origin/missing_destination before any request', async () => {
  const session = makeSession();
  await session.calculate();
  let state = session.getState();
  assert.equal(state.error.kind, 'missing_origin');
  assert.equal(session.calls.length, 0);

  session.setOrigin(ORIGIN);
  await session.calculate();
  state = session.getState();
  assert.equal(state.error.kind, 'missing_destination');
  assert.equal(session.calls.length, 0);
});

test('a successful calculate stores the routes, clears the error, and leaves routing phase', async () => {
  const session = makeSession({ routes: [route(1000), route(1200)] });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  const state = session.getState();
  assert.equal(state.pending, false);
  assert.equal(state.error, null);
  assert.equal(state.routes.length, 2);
  assert.equal(state.selectedRoute, 0);
  assert.equal(session.phase(), 'routes');
});

test('an empty provider answer is the no_route error, never a fabricated route', async () => {
  const session = makeSession({ routes: [] });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  const state = session.getState();
  assert.equal(state.error.kind, 'no_route');
  assert.deepEqual(state.routes, []);
  assert.equal(session.phase(), 'error');
});

test('falsy route entries are filtered from the answer', async () => {
  const session = makeSession({ routes: [null, route(5), undefined] });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  assert.equal(session.getState().routes.length, 1);
});

// ── error mapping ─────────────────────────────────────────────────────────

test('server error codes map onto UI kinds', async () => {
  const session = makeSession({
    routes: () => {
      const err = new Error('Routing is busy right now.');
      err.code = 'rate_limited';
      throw err;
    },
  });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  assert.equal(session.getState().error.kind, 'rate_limited');
  assert.equal(session.getState().error.message, 'Routing is busy right now.');
});

test('an unknown error code degrades to the provider kind', async () => {
  const session = makeSession({
    routes: () => {
      const err = new Error('boom');
      err.code = 'mysterious';
      throw err;
    },
  });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  assert.equal(session.getState().error.kind, 'provider');
  assert.equal(kindFromCode('timeout'), 'timeout');
  assert.equal(kindFromCode('network_error'), 'network');
  assert.equal(kindFromCode('unsupported_mode'), 'unsupported_mode');
});

test('retry re-runs the last request', async () => {
  let fail = true;
  const session = makeSession({
    routes: () => {
      if (fail) {
        const err = new Error('down');
        err.code = 'provider_error';
        throw err;
      }
      return [route(7)];
    },
  });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  assert.equal(session.phase(), 'error');
  fail = false;
  await session.retry();
  const state = session.getState();
  assert.equal(state.error, null);
  assert.equal(state.routes[0].distance, 7);
  assert.equal(session.calls.length, 2);
});

// ── duplicate-request prevention and stale responses ──────────────────────

test('a second calculate supersedes the first: only the latest answer applies', async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const calls = [];
  const fetchRoute = async (request) => {
    calls.push(request);
    return first;
  };
  const session = createDirectionsSession({ fetchRoute, capabilities: CAPS });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  const a = session.calculate();
  const b = session.calculate(); // duplicate: must cancel, not queue
  assert.equal(calls.length, 2);
  resolveFirst([route(1)]); // both awaits settle with the same answer
  await Promise.all([a.catch(() => {}), b]);
  await new Promise((r) => setTimeout(r, 5));
  const state = session.getState();
  assert.equal(state.pending, false);
  assert.equal(state.routes.length, 1);
  assert.equal(state.routes[0].distance, 1);
  // Both calls carried the same (unchanged) request body.
  assert.deepEqual(calls[0], calls[1]);
});

test('a mutation while a request is pending aborts it and drops its late answer', async () => {
  const resolvers = [];
  const calls = [];
  const fetchRoute = (request, { signal } = {}) => {
    calls.push(request);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      resolvers.push(resolve);
    });
  };
  const session = createDirectionsSession({ fetchRoute, capabilities: CAPS });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  const running = session.calculate();
  assert.equal(session.getState().pending, true);

  // The user swaps endpoints mid-flight: the pending request is obsolete.
  session.swap();
  assert.equal(session.getState().pending, false);
  assert.equal(session.getState().routes.length, 0);

  // The aborted fetch rejects; the session must swallow the abort silently.
  await running.catch(() => {});
  // Even a fetcher that ignores the abort and answers late must not win.
  resolvers[0]([route(999)]);
  await new Promise((r) => setTimeout(r, 5));
  const state = session.getState();
  assert.deepEqual(state.routes, []); // never applied
  assert.equal(state.pending, false);
  assert.equal(state.error, null);
  assert.equal(session.phase(), 'form');
});

// ── swap, clear, waypoints, mode ───────────────────────────────────────────

test('swap exchanges origin and destination and reverses the waypoints', async () => {
  const session = makeSession();
  const w1 = { id: 'w1', name: 'Via 1', lat: 50, lon: 8 };
  const w2 = { id: 'w2', name: 'Via 2', lat: 51, lon: 9 };
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  session.addWaypoint(w1);
  session.addWaypoint(w2);
  session.swap();
  const state = session.getState();
  assert.deepEqual(state.origin, DEST);
  assert.deepEqual(state.destination, ORIGIN);
  assert.deepEqual(state.waypoints.map((w) => w.id), ['w2', 'w1']);
});

test('clearAll resets everything, including the retry memory', async () => {
  const session = makeSession({ routes: [] });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate(); // -> no_route error
  session.addWaypoint({ id: 'w', name: 'Via', lat: 50, lon: 8 });
  session.clearAll();
  const state = session.getState();
  assert.equal(state.origin, null);
  assert.equal(state.destination, null);
  assert.deepEqual(state.waypoints, []);
  assert.equal(state.error, null);
  assert.equal(session.phase(), 'form');
  const before = session.calls.length;
  await session.retry(); // nothing left to retry
  assert.equal(session.calls.length, before);
});

test('waypoints are capped at five and gated on the capability', async () => {
  const ungated = makeSession({ capabilities: { modes: ['driving'], alternatives: true, waypoints: false } });
  ungated.addWaypoint({ id: 'w', name: 'Via', lat: 50, lon: 8 });
  assert.deepEqual(ungated.getState().waypoints, []);
  assert.equal(ungated.waypointsSupported(), false);

  const gated = makeSession();
  for (let i = 0; i < 5; i++) {
    gated.addWaypoint({ id: `w${i}`, name: `Via ${i}`, lat: 50 + i, lon: 8 });
  }
  assert.equal(gated.getState().waypoints.length, 5);
  gated.addWaypoint({ id: 'w6', name: 'Via 6', lat: 60, lon: 8 });
  assert.equal(gated.getState().waypoints.length, 5); // over cap: refused
});

test('moveWaypoint reorders and removes take effect in place', async () => {
  const session = makeSession();
  session.addWaypoint({ id: 'a', name: 'A', lat: 50, lon: 8 });
  session.addWaypoint({ id: 'b', name: 'B', lat: 51, lon: 9 });
  session.addWaypoint({ id: 'c', name: 'C', lat: 52, lon: 10 });
  session.moveWaypoint(2, 0);
  assert.deepEqual(session.getState().waypoints.map((w) => w.id), ['c', 'a', 'b']);
  session.removeWaypoint(1);
  assert.deepEqual(session.getState().waypoints.map((w) => w.id), ['c', 'b']);
  session.moveWaypoint(0, 5); // out of range: ignored
  session.removeWaypoint(9); // out of range: ignored
  assert.deepEqual(session.getState().waypoints.map((w) => w.id), ['c', 'b']);
});

test('setMode accepts only supported modes and clears the routes', async () => {
  const session = makeSession();
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  assert.equal(session.phase(), 'routes');
  session.setMode('teleport'); // unknown: ignored
  assert.equal(session.getState().mode, 'driving');
  session.setMode('transit'); // known but unsupported: refused
  assert.equal(session.getState().mode, 'driving');
  session.setMode('walking');
  assert.equal(session.getState().mode, 'walking');
  assert.deepEqual(session.getState().routes, []);
  assert.equal(session.phase(), 'form');
});

test('supportedModes/unsupportedModes split the full mode list on the capability', () => {
  const session = makeSession({ capabilities: { modes: ['driving', 'cycling'], alternatives: false, waypoints: false } });
  assert.deepEqual(session.supportedModes(), ['driving', 'cycling']);
  assert.deepEqual(session.unsupportedModes(), ['walking', 'motorcycle', 'transit']);
  assert.equal(session.alternativesSupported(), false);
});

test('selectRoute switches the highlighted alternative', async () => {
  const session = makeSession({ routes: [route(1), route(2), route(3)] });
  session.setOrigin(ORIGIN);
  session.setDestination(DEST);
  await session.calculate();
  session.selectRoute(2);
  assert.equal(session.getState().selectedRoute, 2);
  session.selectRoute(9); // out of range: ignored
  assert.equal(session.getState().selectedRoute, 2);
});

// ── the Place adapter seam ─────────────────────────────────────────────────

test('toLocationPoint accepts the search-result shape and the Phase 3 Place shape', () => {
  const searchShape = toLocationPoint({ id: '42', name: 'Berlin', detail: 'Germany', lat: 52.52, lon: 13.405 });
  assert.equal(searchShape.name, 'Berlin');
  assert.equal(searchShape.source, 'place');
  const placeShape = toLocationPoint({ name: 'Berlin', location: { lat: 52.52, lng: 13.405 } });
  assert.equal(placeShape.lon, 13.405);
  const placeShapeLon = toLocationPoint({ name: 'Berlin', location: { lat: 52.52, lon: 13.405 } });
  assert.equal(placeShapeLon.lon, 13.405);
});

test('toLocationPoint refuses unusable shapes rather than inventing coordinates', () => {
  assert.equal(toLocationPoint(null), null);
  assert.equal(toLocationPoint({ name: 'No coords' }), null);
  assert.equal(toLocationPoint({ name: '', lat: 1, lon: 2 }), null);
  assert.equal(toLocationPoint({ name: 'Bad', lat: 'north', lon: 2 }), null);
  assert.equal(toLocationPoint({ name: 'Out of range', lat: 95, lon: 2 }), null);
});

test('currentLocationPoint wraps a device fix with an honest label', () => {
  const fix = currentLocationPoint({ lat: 52.52, lng: 13.405, accuracy: 18.2 });
  assert.equal(fix.name, 'Current location');
  assert.equal(fix.detail, 'Accurate to about 18 m');
  assert.equal(fix.source, 'device');
  assert.equal(currentLocationPoint(null), null);
  assert.equal(currentLocationPoint({ lat: NaN, lng: 0 }), null);
  assert.equal(currentLocationPoint({ lat: 52.52, lng: 13.405 }).detail, null);
});

// ── formatting (the "12.4 km · 24 min" summary line) ───────────────────────

test('formatDistance renders metres and kilometres, null for missing values', () => {
  assert.equal(formatDistance(450), '450 m');
  assert.equal(formatDistance(12400), '12.4 km');
  assert.equal(formatDistance(124000), '124 km');
  assert.equal(formatDistance(null), null);
  assert.equal(formatDistance(-1), null);
});

test('formatDuration renders minutes and hours, null for missing values', () => {
  assert.equal(formatDuration(30), '< 1 min');
  assert.equal(formatDuration(1440), '24 min');
  assert.equal(formatDuration(5040), '1 h 24 min');
  assert.equal(formatDuration(7200), '2 h');
  assert.equal(formatDuration(null), null);
});

test('routeLine never invents a half: missing parts read unavailable', () => {
  assert.equal(routeLine({ distance: 12400, duration: 1440 }), '12.4 km · 24 min');
  assert.equal(routeLine({ distance: 12400 }), '12.4 km · Duration unavailable');
  assert.equal(routeLine({ duration: 1440 }), 'Distance unavailable · 24 min');
  assert.equal(routeLine(null), 'Distance unavailable · Duration unavailable');
});

test('geometryBounds derives the fit bounds from real geometry', () => {
  assert.deepEqual(geometryBounds([[13, 52], [11, 54], [12, 50]]), {
    west: 11, south: 50, east: 13, north: 54,
  });
  assert.equal(geometryBounds([]), null);
  assert.equal(geometryBounds(null), null);
  assert.equal(geometryBounds([[13], ['x', 2]]), null);
});

test('routeError carries the kind and the plain-language copy', () => {
  const err = routeError('no_route');
  assert.equal(err.kind, 'no_route');
  assert.match(err.message, /No route was found/);
  assert.equal(routeError('missing_origin').message, 'Choose a starting point first.');
});
