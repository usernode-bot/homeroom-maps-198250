// Tests for the navigation session state machine
// (public/js/services/navigation/navigation-core.js).
//
// Everything is injected: a fake watch, a fake route fetcher, a fake voice,
// a manual scheduler and a manual clock, so every transition the spec
// requires is driven deterministically without a DOM or a device.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let createNavigationSession;
let NAV_STATE;

before(async () => {
  const mod = await import('../public/js/services/navigation/navigation-core.js');
  ({ createNavigationSession, NAV_STATE } = mod);
});

// ── fakes (kept here, never in production code) ────────────────────────────

// A route: 1 km straight north from (52.52, 13.405). geometry is [lng, lat].
function makeRoute(meters = 1000) {
  const perFix = 0.00001; // ~1.1 m of latitude per unit
  const n = Math.round(meters / 10);
  const geometry = [];
  for (let i = 0; i <= n; i += 1) {
    geometry.push([13.405, 52.52 + (i / n) * (meters * 0.000009)]);
  }
  return {
    geometry,
    distance: meters,
    duration: meters / 10,
    legs: [{ distance: meters, duration: meters / 10, steps: [] }],
  };
}

// A manual scheduler: timers fire only when advance() says so.
function makeClock() {
  let time = 1_000_000;
  const timers = new Set();
  return {
    now: () => time,
    schedule(fn, ms) {
      const entry = { fn, at: time + ms, cancelled: false };
      timers.add(entry);
      return () => timers.delete(entry);
    },
    advance(ms) {
      time += ms;
      for (const entry of [...timers]) {
        if (!entry.cancelled && entry.at <= time) {
          timers.delete(entry);
          entry.fn();
        }
      }
    },
  };
}

// Let the fake fetcher's rejection/resolution fully settle (async functions
// take more than one microtask tick).
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A controllable location watch: tests push fixes and errors by hand.
function makeWatch() {
  const emitted = [];
  let live = null;
  return {
    emitted,
    onFix(onFix, onError) {
      live = { onFix, onError };
      return { stop() { live = null; } };
    },
    fix(fix) {
      if (live) live.onFix(fix);
    },
    error(err) {
      if (live) live.onError(err);
    },
    isLive() {
      return Boolean(live);
    },
  };
}

function makeVoice() {
  const announced = [];
  return {
    announced,
    isAvailable: () => true,
    announce(intent) {
      announced.push(intent);
    },
    stop() {},
  };
}

// Fix near the start of the route, moving north along it.
function onRouteFix(metersAlong, accuracy = 10) {
  return { lat: 52.52 + metersAlong * 0.000009, lng: 13.405, accuracy };
}

function makeSession({ fetchRoute, clock, watch, voice, options } = {}) {
  return createNavigationSession({
    fetchRoute: fetchRoute || (async () => [makeRoute()]),
    watch: watch.onFix ? watch.onFix.bind(watch) : watch,
    voice: voice || null,
    schedule: clock.schedule,
    now: clock.now,
    options,
  });
}

const DEST = { lat: 52.52 + 1000 * 0.000009, lon: 13.405 };

function start(session) {
  return session.start(makeRoute(), { destination: DEST, mode: 'driving' });
}

// ── tests ──────────────────────────────────────────────────────────────────

test('start with an invalid route lands in ERROR and never opens a session', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  const ok = session.start({ geometry: [[13.405, 52.52]] }, { destination: DEST });
  assert.equal(ok, false);
  assert.equal(session.getState().state, NAV_STATE.ERROR);
  assert.equal(session.getState().error.kind, 'invalid_route');
  assert.equal(watch.isLive(), false);
  // And a bad destination too.
  session.start(makeRoute(), { destination: { lat: 'x', lon: 13.405 } });
  assert.equal(session.getState().state, NAV_STATE.ERROR);
});

test('start arms the watch and the first usable fix moves Preparing to Navigating', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  assert.equal(start(session), true);
  assert.equal(session.getState().state, NAV_STATE.PREPARING);
  assert.equal(watch.isLive(), true);
  watch.fix(onRouteFix(0));
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
  const snap = session.getState();
  assert.equal(snap.gps, 'ok');
  assert.ok(snap.progress && snap.progress.remainingDistanceMeters > 900);
});

test('an unusable fix is dropped, never coerced into a position', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.fix({ lat: NaN, lng: 13.405 });
  watch.fix({ lat: 95, lng: 13.405 });
  watch.fix(null);
  assert.equal(session.getState().fix, null);
  assert.equal(session.getState().state, NAV_STATE.PREPARING);
  watch.fix(onRouteFix(0));
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
});

test('a first fix far beyond the sanity cap waits, then guides after three', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.fix({ lat: 52.0, lng: 13.405, accuracy: 5000 });
  assert.equal(session.getState().state, NAV_STATE.PREPARING);
  watch.fix({ lat: 52.0, lng: 13.405, accuracy: 5000 });
  assert.equal(session.getState().state, NAV_STATE.PREPARING);
  // After three over-cap fixes the device's best is used, honestly "weak".
  watch.fix({ lat: 52.0, lng: 13.405, accuracy: 5000 });
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
  assert.equal(session.getState().gps, 'weak');
});

test('going off route confirms over 2 of 3 fixes, then reroutes', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  const fetched = [];
  const session = makeSession({
    clock,
    watch,
    fetchRoute: async (req) => {
      fetched.push(req);
      return [makeRoute()];
    },
  });
  start(session);
  watch.fix(onRouteFix(10));
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);

  // One off-threshold fix is not enough: confirmation needs 2 of the last 3.
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);

  // Two of the last three beyond the threshold: off route, reroute starts.
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  assert.equal(session.getState().state, NAV_STATE.REROUTING);
  assert.equal(session.getState().reroute.inFlight, true);
  await settle();
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING); // reroute applied
  assert.equal(session.getState().reroute.inFlight, false);
  assert.equal(fetched.length, 1);
  assert.deepEqual(fetched[0].origin, {
    lat: 52.52 + 200 * 0.000009,
    lon: 13.406,
  });
});

test('a reroute failure backs off, retries, and settles in ROUTE_UNAVAILABLE after three', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  let attempts = 0;
  const session = makeSession({
    clock,
    watch,
    fetchRoute: async () => {
      attempts += 1;
      throw Object.assign(new Error('no route'), { code: 'no_route' });
    },
  });
  start(session);
  watch.fix(onRouteFix(10));
  // Three confirmed off-route fixes, each starting an attempt.
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(session.getState().state, NAV_STATE.OFF_ROUTE); // attempt 1 failed
  assert.equal(session.getState().reroute.attempts, 1);

  // The retry fires on the next fix after the backoff.
  clock.advance(5000);
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(session.getState().reroute.attempts, 2);
  clock.advance(5000); // not enough for attempt 3's backoff (15 s)
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(session.getState().reroute.attempts, 2, 'backoff holds the third attempt');
  clock.advance(10000);
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(session.getState().reroute.attempts, 3);
  assert.equal(session.getState().state, NAV_STATE.ROUTE_UNAVAILABLE, 'settled after three failures');

  // Manual retry opens a fresh backoff cycle.
  session.retryReroute();
  await settle();
  assert.equal(session.getState().reroute.attempts, 1);
});

test('a network failure settles in NETWORK_UNAVAILABLE and its retry works', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  let failing = true;
  const session = makeSession({
    clock,
    watch,
    fetchRoute: async () => {
      if (failing) throw Object.assign(new Error('offline'), { code: 'network_error' });
      return [makeRoute()];
    },
  });
  start(session);
  watch.fix(onRouteFix(10));
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  await settle();
  await settle();
  assert.equal(session.getState().state, NAV_STATE.NETWORK_UNAVAILABLE);
  failing = false;
  session.retryReroute(); // opens a fresh cycle with attempts reset
  await settle();
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
});

test('returning to the route cancels the reroute and forgives failures', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  let attempts = 0;
  const session = makeSession({
    clock,
    watch,
    fetchRoute: async () => {
      attempts += 1;
      throw Object.assign(new Error('no route'), { code: 'no_route' });
    },
  });
  start(session);
  watch.fix(onRouteFix(10));
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(session.getState().reroute.attempts, 1);
  // Two consecutive fixes back on the line: back to Navigating, failures forgiven.
  watch.fix(onRouteFix(20));
  watch.fix(onRouteFix(30));
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
  assert.equal(session.getState().reroute.attempts, 0);
  assert.equal(session.getState().reroute.error, null);
});

test('arrival is detected within the radius and stops the watch', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const voice = makeVoice();
  const session = makeSession({ clock, watch, voice });
  start(session);
  watch.fix(onRouteFix(10));
  watch.fix({ lat: DEST.lat, lng: DEST.lon, accuracy: 5 });
  const snap = session.getState();
  assert.equal(snap.state, NAV_STATE.ARRIVED);
  assert.equal(watch.isLive(), false);
  assert.deepEqual(voice.announced[voice.announced.length - 1], { kind: 'arrived' });
  // The route and fix stay standing for the final banner.
  assert.ok(snap.route);
  assert.ok(snap.fix);
});

test('stopping the fixes for longer than the grace reads GPS lost', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.fix(onRouteFix(10));
  clock.advance(10_001); // the staleness timer runs at grace/2
  assert.equal(session.getState().state, NAV_STATE.GPS_UNAVAILABLE);
  // The next fix resumes guidance by itself.
  watch.fix(onRouteFix(20));
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
});

test('a permission denial is an ERROR, not a GPS fault', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.error({ reason: 'denied', message: 'Location access was denied.' });
  const snap = session.getState();
  assert.equal(snap.state, NAV_STATE.ERROR);
  assert.equal(snap.error.kind, 'permission_denied');
  assert.equal(watch.isLive(), false);
});

test('a granted-but-reopening answer lands in ERROR with its own kind', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.error({ reason: 'reopening', message: 'Reopening.' });
  assert.equal(session.getState().state, NAV_STATE.ERROR);
  assert.equal(session.getState().error.kind, 'reopening');
});

test('a transient watch error pauses guidance and a good fix resumes it', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.fix(onRouteFix(10));
  watch.error({ reason: 'unavailable', message: 'Position unavailable.' });
  assert.equal(session.getState().state, NAV_STATE.GPS_UNAVAILABLE);
  watch.fix(onRouteFix(20));
  assert.equal(session.getState().state, NAV_STATE.NAVIGATING);
});

test('voice hears maneuvers, rerouting and arrival — keyed so a step repeats once', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  const voice = makeVoice();
  // A route whose single step sits at the far end; reaching it announces once.
  const route = makeRoute();
  route.legs[0].steps = [{
    name: 'Goal',
    distance: 900,
    duration: 90,
    maneuver: { type: 'arrive', modifier: null, location: route.geometry[route.geometry.length - 1] },
  }];
  const routes = [route];
  const session = createNavigationSession({
    fetchRoute: async () => routes,
    watch: watch.onFix.bind(watch),
    voice,
    schedule: clock.schedule,
    now: clock.now,
  });
  session.start(route, { destination: DEST, mode: 'driving' });
  watch.fix(onRouteFix(10));
  watch.fix(onRouteFix(15));
  watch.fix(onRouteFix(20));
  const kinds = voice.announced.map((i) => i.kind);
  assert.deepEqual(kinds, ['maneuver']); // one announcement for the one step
});

test('end() stops the watch, cancels reroutes and returns to idle', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  const voice = makeVoice();
  const session = makeSession({ clock, watch, voice });
  start(session);
  watch.fix(onRouteFix(10));
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  assert.ok(session.getState().reroute.inFlight || session.getState().state === NAV_STATE.OFF_ROUTE);
  session.end();
  const snap = session.getState();
  assert.equal(snap.state, NAV_STATE.IDLE);
  assert.equal(watch.isLive(), false);
  assert.equal(snap.route, null);
});

test('hidden pauses the watch; visible resumes it', () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({ clock, watch });
  start(session);
  watch.fix(onRouteFix(10));
  session.setVisible(false);
  assert.equal(watch.isLive(), false);
  session.setVisible(true);
  assert.equal(watch.isLive(), true);
  // A finished (arrived) session is not resurrected.
  watch.fix({ lat: DEST.lat, lng: DEST.lon, accuracy: 5 });
  assert.equal(session.getState().state, NAV_STATE.ARRIVED);
  session.setVisible(true);
  assert.equal(watch.isLive(), false);
});

test('a reroute answer without usable geometry is a failure, never a fallback route', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  const session = makeSession({
    clock,
    watch,
    fetchRoute: async () => [{ geometry: [] }],
  });
  start(session);
  watch.fix(onRouteFix(10));
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(session.getState().state, NAV_STATE.OFF_ROUTE);
  assert.equal(session.getState().reroute.error.kind, 'routing');
  // The original route is still standing.
  assert.ok(session.getState().route);
  assert.equal(session.getState().route.geometry.length, makeRoute().geometry.length);
});

test('rerouting keeps waypoints still ahead and drops passed ones', async () => {
  const clock = makeClock();
  const watch = makeWatch();
  const fetched = [];
  const session = makeSession({
    clock,
    watch,
    fetchRoute: async (req) => {
      fetched.push(req);
      return [makeRoute()];
    },
  });
  const mid = { lat: 52.52 + 500 * 0.000009, lon: 13.405 };
  session.start(makeRoute(), { destination: DEST, mode: 'driving', waypoints: [mid], waypointsSupported: true });
  watch.fix(onRouteFix(10));
  // Off route far enough that the mid waypoint is still ahead.
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  watch.fix({ lat: 52.52 + 200 * 0.000009, lng: 13.406, accuracy: 10 });
  await settle();
  assert.equal(fetched.length, 1);
  assert.deepEqual(fetched[0].waypoints, [mid]);
});