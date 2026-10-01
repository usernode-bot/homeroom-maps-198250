// Navigation session core — the pure state machine behind turn-by-turn
// navigation, extracted so node:test can drive every required behavior
// without a DOM (the same pattern as routing-core.js beside it).
//
// Dependencies are injected: the route fetcher (the existing Routing contract
// via services/routing.js), a continuous location watch (the existing
// Location contract via services/location.js), a voice adapter (the
// NavigationVoiceService interface), a scheduler and a clock for testable
// timing. The module itself imports only the pure progress math beside it.
//
// NOTHING here fabricates navigation data. The route is the provider's
// RouteResult; progress, maneuver distances and remaining figures are
// measurements over that route and the device's real fixes. A value that
// cannot be measured (steps without usable locations, no fix yet) is null and
// the UI shows "unavailable". A reroute that fails leaves the last valid
// route standing — a fake fallback route is never generated.
'use strict';

import {
  createRouteTracker,
  buildManeuverSchedule,
  computeRouteProgress,
  isArrived,
} from './progress.js';

export const NAV_STATE = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing',
  NAVIGATING: 'navigating',
  OFF_ROUTE: 'off_route',
  REROUTING: 'rerouting',
  ARRIVED: 'arrived',
  GPS_UNAVAILABLE: 'gps_unavailable',
  NETWORK_UNAVAILABLE: 'network_unavailable',
  ROUTE_UNAVAILABLE: 'route_unavailable',
  ERROR: 'error',
});

const DEFAULTS = {
  offRouteMeters: 50,          // deviation threshold, widened by fix accuracy
  offRouteConfirmCount: 2,     // of the last 3 fixes beyond the threshold
  weakGpsAccuracyMeters: 50,   // reported accuracy worse than this reads "weak"
  arrivalRadiusMeters: 30,     // widened by fix accuracy
  firstFixMaxAccuracyMeters: 1000, // sanity cap on the fix that leaves Preparing
  gpsLostGraceMs: 10000,       // fixes stopping this long read "GPS signal lost"
  rerouteMinIntervalMs: 10000, // a reroute is never attempted more often
  rerouteBackoffMs: [0, 5000, 15000], // delay before attempts 1, 2, 3
  maxRerouteFailures: 3,       // consecutive failures settle in a failure state
};

// Threshold for one fix: the off-route distance widened by its reported
// accuracy, so a noisy fix is not punished for the device's imprecision.
function deviationThreshold(base, fix) {
  return base + (Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : 0);
}

function routeFailureKind(err) {
  const code = err && (err.kind || err.code);
  if (code === 'network' || code === 'network_error') return 'network';
  return 'routing';
}

function failureMessage(err) {
  return err && typeof err.message === 'string' && err.message ? err.message : null;
}

function isAbort(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

export function createNavigationSession({
  fetchRoute,  // (request, { signal }) -> Promise<RouteResult[]>  required
  watch,       // (onFix, onError) -> { stop() }                   required
  voice = null,// { announce(intent), stop() }                     optional
  schedule = null, // (fn, ms) -> cancel()  timers; default setTimeout
  now = null,  // () -> ms; default Date.now
  options = {},
} = {}) {
  if (typeof fetchRoute !== 'function') {
    throw new Error('createNavigationSession needs a fetchRoute function.');
  }
  if (typeof watch !== 'function') {
    throw new Error('createNavigationSession needs a watch function.');
  }
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const clock = now || (() => Date.now());
  const timer = schedule || (typeof setTimeout === 'function'
    ? (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      }
    : null);

  let state = NAV_STATE.IDLE;
  let route = null;        // the active RouteResult, by reference, never copied
  let tracker = null;      // progress.createRouteTracker over its geometry
  let maneuverSchedule = [];
  let destination = null;  // { lat, lon }
  let pendingWaypoints = []; // [{ lat, lon }] still ahead on the requested path
  let mode = null;
  let waypointsSupported = false;

  let fix = null;          // last usable fix
  let fixCount = 0;
  let lastFixAt = 0;
  let hasNavigated = false;
  let gps = 'locating';    // 'locating' | 'ok' | 'weak' | 'lost'
  let gpsMessage = null;
  let progress = null;     // last computeRouteProgress result (scalars + refs)
  let projectedHint = 0;

  let offRouteWindow = []; // last 3 booleans: beyond the threshold?
  let rerouteAttempts = 0;
  let lastRerouteAt = 0;
  let rerouteInFlight = false;
  let rerouteGeneration = 0;
  let rerouteController = null;
  let rerouteError = null; // { kind: 'network'|'routing', message }
  let sessionError = null; // { kind, message } for the ERROR state
  let announcedManeuver = null;

  let wantWatching = false;
  let watchHandle = null;
  let staleTimer = null;
  let ended = true;

  const listeners = new Set();

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function snapshot() {
    return {
      state,
      route,
      destination,
      waypoints: [...pendingWaypoints],
      mode,
      fix: fix ? { ...fix } : null,
      gps,
      gpsMessage,
      progress: progress ? { ...progress } : null,
      error: sessionError ? { ...sessionError } : null,
      reroute: {
        attempts: rerouteAttempts,
        inFlight: rerouteInFlight,
        error: rerouteError ? { ...rerouteError } : null,
      },
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  function validGeometry(geometry) {
    return Array.isArray(geometry) &&
      geometry.length >= 2 &&
      geometry.every((pt) => Array.isArray(pt) && pt.length >= 2 && pt.every(Number.isFinite));
  }

  function start(input, { destination: dest, waypoints = [], mode: m = null, waypointsSupported: wp = false } = {}) {
    const geometry = input && validGeometry(input.geometry) ? input.geometry : null;
    const destOk = dest && Number.isFinite(dest.lat) && Number.isFinite(dest.lon);
    if (!geometry || !destOk) {
      // An invalid route can never enter navigation; no fake session is built.
      resetAll();
      ended = false;
      state = NAV_STATE.ERROR;
      sessionError = { kind: 'invalid_route', message: null };
      emit();
      return false;
    }

    route = input;
    tracker = createRouteTracker(geometry);
    maneuverSchedule = buildManeuverSchedule(tracker, route);
    destination = { lat: dest.lat, lon: dest.lon };
    pendingWaypoints = (Array.isArray(waypoints) ? waypoints : [])
      .filter((w) => w && Number.isFinite(w.lat) && Number.isFinite(w.lon))
      .map((w) => ({ lat: w.lat, lon: w.lon }));
    mode = m || null;
    waypointsSupported = Boolean(wp);

    ended = false;
    hasNavigated = false;
    fix = null;
    fixCount = 0;
    lastFixAt = 0;
    progress = null;
    projectedHint = 0;
    offRouteWindow = [];
    rerouteAttempts = 0;
    lastRerouteAt = 0;
    rerouteError = null;
    sessionError = null;
    announcedManeuver = null;
    gps = 'locating';
    gpsMessage = null;
    state = NAV_STATE.PREPARING;

    startWatch();
    emit();
    return true;
  }

  function end() {
    ended = true;
    wantWatching = false;
    stopWatch();
    cancelStaleTimer();
    cancelReroute();
    if (voice && typeof voice.stop === 'function') voice.stop();
    resetAll();
    emit();
  }

  function resetAll() {
    state = NAV_STATE.IDLE;
    route = null;
    tracker = null;
    maneuverSchedule = [];
    destination = null;
    pendingWaypoints = [];
    mode = null;
    waypointsSupported = false;
    fix = null;
    fixCount = 0;
    lastFixAt = 0;
    hasNavigated = false;
    progress = null;
    projectedHint = 0;
    offRouteWindow = [];
    rerouteAttempts = 0;
    lastRerouteAt = 0;
    rerouteInFlight = false;
    rerouteError = null;
    sessionError = null;
    announcedManeuver = null;
    gps = 'locating';
    gpsMessage = null;
  }

  // Platform visibility (usernode:visibility-changed): pause tracking and
  // speech while hidden, resume on show. Arrived/Error sessions stay put.
  function setVisible(visible) {
    if (ended) return;
    if (!visible) {
      stopWatch();
      cancelStaleTimer();
      if (voice && typeof voice.stop === 'function') voice.stop();
      return;
    }
    if (wantWatching && !watchHandle &&
        [NAV_STATE.PREPARING, NAV_STATE.NAVIGATING, NAV_STATE.OFF_ROUTE, NAV_STATE.REROUTING, NAV_STATE.GPS_UNAVAILABLE].includes(state)) {
      startWatch();
    }
  }

  // ── location watch ───────────────────────────────────────────────────────

  function startWatch() {
    wantWatching = true;
    if (watchHandle) return;
    watchHandle = watch(onFix, onWatchError);
    armStaleTimer();
  }

  function stopWatch() {
    if (watchHandle) {
      try {
        watchHandle.stop();
      } catch {
        /* a stop that throws must not break the session */
      }
    }
    watchHandle = null;
  }

  function armStaleTimer() {
    cancelStaleTimer();
    if (!timer) return;
    staleTimer = timer(checkStale, Math.max(500, Math.ceil(cfg.gpsLostGraceMs / 2)));
  }

  function cancelStaleTimer() {
    if (staleTimer) {
      try {
        staleTimer();
      } catch {
        /* ignore */
      }
    }
    staleTimer = null;
  }

  function checkStale() {
    staleTimer = null;
    if (!wantWatching || ended) return;
    if (lastFixAt && clock() - lastFixAt > cfg.gpsLostGraceMs &&
        [NAV_STATE.PREPARING, NAV_STATE.NAVIGATING, NAV_STATE.OFF_ROUTE, NAV_STATE.REROUTING].includes(state)) {
      state = NAV_STATE.GPS_UNAVAILABLE;
      gps = 'lost';
      emit();
    }
    armStaleTimer();
  }

  function onWatchError(err) {
    if (ended) return;
    const reason = err && err.reason;
    const message = failureMessage(err);
    // A permission answer is a person's decision, not a GPS fault: it lands
    // in the ERROR state with the platform flow's own copy and stops the watch.
    if (reason === 'denied' || reason === 'declined' || reason === 'not_declared') {
      stopWatch();
      cancelStaleTimer();
      wantWatching = false;
      state = NAV_STATE.ERROR;
      sessionError = { kind: 'permission_denied', message };
      gps = 'lost';
      emit();
      return;
    }
    if (reason === 'reopening') {
      // Granted, and the shell is about to reload this frame to apply it.
      stopWatch();
      cancelStaleTimer();
      wantWatching = false;
      state = NAV_STATE.ERROR;
      sessionError = { kind: 'reopening', message };
      emit();
      return;
    }
    // Transient watch failures (timeout, unavailable): pause guidance, keep
    // watching. The next good fix leaves GPS_UNAVAILABLE by itself.
    if (state === NAV_STATE.GPS_UNAVAILABLE && gpsMessage === message) return;
    gpsMessage = message;
    gps = 'lost';
    if ([NAV_STATE.PREPARING, NAV_STATE.NAVIGATING, NAV_STATE.OFF_ROUTE, NAV_STATE.REROUTING].includes(state)) {
      state = NAV_STATE.GPS_UNAVAILABLE;
    }
    emit();
  }

  // ── fixes ────────────────────────────────────────────────────────────────

  function onFix(raw) {
    if (ended || !wantWatching) return;
    if (!raw || typeof raw !== 'object') return; // no fix to read, never a (0,0)
    const lat = Number(raw.lat);
    const lng = Number(raw && (raw.lng != null ? raw.lng : raw.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return; // an unusable fix is dropped, never coerced into a position
    }
    const accuracy = Number.isFinite(raw.accuracy) && raw.accuracy > 0 ? raw.accuracy : null;
    fix = {
      lat,
      lng,
      accuracy,
      heading: raw && Number.isFinite(raw.heading) ? raw.heading : null,
      speed: raw && Number.isFinite(raw.speed) && raw.speed >= 0 ? raw.speed : null,
      timestamp: clock(),
    };
    lastFixAt = fix.timestamp;
    fixCount += 1;
    gps = accuracy != null && accuracy > cfg.weakGpsAccuracyMeters ? 'weak' : 'ok';
    gpsMessage = null;

    // A paused (GPS_UNAVAILABLE) session resumes by itself on the next fix.
    if (state === NAV_STATE.GPS_UNAVAILABLE) {
      state = hasNavigated ? NAV_STATE.NAVIGATING : NAV_STATE.PREPARING;
    }

    if (!hasNavigated) {
      // Preparing: wait for a fix whose accuracy is sane enough to guide with,
      // but do not wait forever — after three over-cap fixes, guide with the
      // best the device can give (honestly flagged "weak" by the accuracy).
      if (accuracy != null && accuracy > cfg.firstFixMaxAccuracyMeters && fixCount < 3) {
        gps = 'weak';
        emit();
        return;
      }
      hasNavigated = true;
    }

    processFix();
  }

  function processFix() {
    // The first usable fix opens guidance itself.
    if (state === NAV_STATE.PREPARING && hasNavigated) {
      state = NAV_STATE.NAVIGATING;
    }
    recomputeProgress();

    // Arrival works from any active guidance state and is measured, never timed.
    if ([NAV_STATE.NAVIGATING, NAV_STATE.OFF_ROUTE, NAV_STATE.REROUTING, NAV_STATE.ROUTE_UNAVAILABLE, NAV_STATE.NETWORK_UNAVAILABLE]
      .includes(state) &&
        isArrived(fix, destination, tracker ? tracker.endPoint : null, cfg.arrivalRadiusMeters)) {
      arrive();
      return;
    }

    const threshold = deviationThreshold(cfg.offRouteMeters, fix);
    const offRouteNow = progress ? progress.offRouteMeters > threshold : false;

    // Hysteresis, both directions on 2 of the last 3 fixes, so GPS jitter at
    // the boundary cannot flicker the state.
    offRouteWindow.push(offRouteNow);
    if (offRouteWindow.length > 3) offRouteWindow.shift();
    const confirmed = offRouteWindow.filter(Boolean).length >= cfg.offRouteConfirmCount && offRouteWindow.length >= cfg.offRouteConfirmCount;

    const backForTwoFixes =
      offRouteWindow.length >= 2 && !offRouteWindow[offRouteWindow.length - 1] && !offRouteWindow[offRouteWindow.length - 2];
    if (backForTwoFixes &&
        [NAV_STATE.OFF_ROUTE, NAV_STATE.REROUTING, NAV_STATE.ROUTE_UNAVAILABLE, NAV_STATE.NETWORK_UNAVAILABLE].includes(state)) {
      // Back on the route (two consecutive fixes inside the threshold): drop
      // the reroute attempt (if any), forgive failures.
      cancelReroute();
      rerouteAttempts = 0;
      rerouteError = null;
      state = NAV_STATE.NAVIGATING;
    }

    if (state === NAV_STATE.NAVIGATING && confirmed) {
      state = NAV_STATE.OFF_ROUTE;
      tryReroute();
    } else if ([NAV_STATE.OFF_ROUTE, NAV_STATE.NETWORK_UNAVAILABLE].includes(state) && confirmed && !rerouteInFlight) {
      // Still off route after a failed attempt: retry when the backoff allows.
      tryReroute();
    }

    announceManeuver();
    emit();
  }

  function recomputeProgress() {
    if (!tracker || !fix) {
      progress = null;
      return;
    }
    const proj = tracker.project(fix.lat, fix.lng, projectedHint);
    if (!proj) {
      progress = null;
      return;
    }
    projectedHint = proj.segmentIndex;
    progress = computeRouteProgress({
      tracker,
      route,
      fix,
      proj,
      schedule: maneuverSchedule,
    });
  }

  function arrive() {
    cancelReroute();
    stopWatch();
    cancelStaleTimer();
    wantWatching = false;
    state = NAV_STATE.ARRIVED;
    // The completed session is preserved (final banner, route, fix) until the
    // person ends it.
    if (voice) voice.announce({ kind: 'arrived' });
    emit();
  }

  // ── rerouting ────────────────────────────────────────────────────────────

  // Waypoints of the original request still ahead of the current position,
  // measured against the active route. A waypoint that cannot be placed on
  // the line is kept: dropping it would change the trip.
  function remainingWaypoints() {
    if (!waypointsSupported) return [];
    return pendingWaypoints.filter((w) => {
      if (!tracker) return true;
      const proj = tracker.project(w.lat, w.lon, 0);
      if (!proj) return true;
      return !progress || proj.positionMeters > progress.positionMeters;
    });
  }

  function tryReroute() {
    if (rerouteInFlight || !fix || !destination) return;
    if (rerouteAttempts >= cfg.maxRerouteFailures) return;
    if (clock() - lastRerouteAt < backoffFor(rerouteAttempts)) return;

    rerouteInFlight = true;
    rerouteAttempts += 1;
    lastRerouteAt = clock();
    const gen = ++rerouteGeneration;
    rerouteController = new AbortController();
    state = NAV_STATE.REROUTING;
    if (voice) voice.announce({ kind: 'rerouting' });
    emit();

    const waypoints = remainingWaypoints();
    fetchRoute(
      {
        origin: { lat: fix.lat, lon: fix.lng },
        destination: { lat: destination.lat, lon: destination.lon },
        waypoints,
        mode,
      },
      { signal: rerouteController.signal },
    ).then((routes) => {
      if (gen !== rerouteGeneration || ended) return; // superseded or ended
      rerouteInFlight = false;
      const list = Array.isArray(routes) ? routes.filter(Boolean) : [];
      if (!list.length) {
        rerouteFailed({ code: 'no_route', message: null });
        return;
      }
      applyReroute(list[0], waypoints);
    }).catch((err) => {
      if (gen !== rerouteGeneration || ended) return;
      rerouteInFlight = false;
      if (isAbort(err)) return;
      rerouteFailed(err);
    });
  }

  function backoffFor(attempts) {
    const list = cfg.rerouteBackoffMs;
    return list[Math.min(Math.max(attempts, 0), list.length - 1)];
  }

  function rerouteFailed(err) {
    rerouteError = { kind: routeFailureKind(err), message: failureMessage(err) };
    if (rerouteAttempts >= cfg.maxRerouteFailures) {
      // Settled: the last valid route stays drawn, guidance is honestly dead.
      state = rerouteError.kind === 'network' ? NAV_STATE.NETWORK_UNAVAILABLE : NAV_STATE.ROUTE_UNAVAILABLE;
    } else {
      // Intermediate failure: back on the off-route banner, auto-retry after
      // the backoff, on the next fix.
      state = rerouteError.kind === 'network' ? NAV_STATE.NETWORK_UNAVAILABLE : NAV_STATE.OFF_ROUTE;
    }
    emit();
  }

  function applyReroute(newRoute, waypointsUsed) {
    if (!newRoute || !validGeometry(newRoute.geometry)) {
      // A reroute answer without usable geometry is a failure, never a
      // hand-built fallback.
      rerouteFailed({ code: 'no_route', message: null });
      return;
    }
    route = newRoute;
    tracker = createRouteTracker(route.geometry);
    maneuverSchedule = buildManeuverSchedule(tracker, route);
    pendingWaypoints = Array.isArray(waypointsUsed) ? waypointsUsed : pendingWaypoints;
    projectedHint = 0;
    announcedManeuver = null;
    offRouteWindow = [];
    rerouteAttempts = 0;
    rerouteError = null;
    state = NAV_STATE.NAVIGATING;
    recomputeProgress();
    announceManeuver();
    emit();
  }

  function cancelReroute() {
    rerouteGeneration += 1;
    if (rerouteController) {
      try {
        rerouteController.abort();
      } catch {
        /* ignore */
      }
    }
    rerouteController = null;
    rerouteInFlight = false;
  }

  // Manual recovery from a settled failure: a fresh backoff cycle.
  function retryReroute() {
    if (ended) return;
    if (![NAV_STATE.ROUTE_UNAVAILABLE, NAV_STATE.NETWORK_UNAVAILABLE, NAV_STATE.OFF_ROUTE].includes(state)) return;
    rerouteAttempts = 0;
    rerouteError = null;
    lastRerouteAt = 0;
    tryReroute();
  }

  // ── voice ────────────────────────────────────────────────────────────────

  // The session emits semantic intents ({ kind, step }); the voice adapter
  // resolves them into spoken words, so copy stays in the i18n layer.
  function announceManeuver() {
    const next = progress && progress.nextManeuver;
    const key = next ? `${next.legIndex}:${next.stepIndex}` : null;
    if (key === announcedManeuver) return;
    announcedManeuver = key;
    if (next && voice) voice.announce({ kind: 'maneuver', step: next.step });
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: snapshot,
    start,
    end,
    retryReroute,
    setVisible,
  };
}