// Directions session core — the pure, import-free state machine behind the
// Directions screen. Extracted from the screen so node:test can drive every
// required behavior (validation, swap, waypoints, mode capability, stale
// responses, alternative selection) without a DOM: this module imports
// nothing, and the side-effectful fetcher is injected — the same shape as
// search-session.js beside it.
//
// The UI layer (screens/directions.js) binds the real fetcher
// (services/routing.js -> /api/directions); everything state-machine-shaped
// lives here and nothing is fabricated: a field the provider did not supply
// stays null, an unsupported mode is refused, and a failed request is the
// error state, never a made-up route.
'use strict';

// The travel modes the app models. Which of them the ACTIVE provider serves
// comes from the routing capabilities in /api/config — never assumed here.
export const TRAVEL_MODES = {
  driving: 'Driving',
  walking: 'Walking',
  cycling: 'Cycling',
  motorcycle: 'Motorcycle',
  transit: 'Transit',
};

// Matches the server's cap (routing/normalize.js); the UI never offers more.
export const MAX_WAYPOINTS = 5;

// ── typed errors ─────────────────────────────────────────────────────────

// `kind` is what the UI switches on; `message` is plain-language copy.
export const ROUTE_ERROR_KINDS = {
  missing_origin: 'missing_origin',
  missing_destination: 'missing_destination',
  invalid_request: 'invalid_request',
  no_route: 'no_route',
  unsupported_mode: 'unsupported_mode',
  rate_limited: 'rate_limited',
  timeout: 'timeout',
  network: 'network',
  provider: 'provider',
};

export const ROUTE_ERROR_COPY = {
  missing_origin: 'Choose a starting point first.',
  missing_destination: 'Choose a destination first.',
  invalid_request: 'These locations could not form a route request.',
  no_route: 'No route was found between these points. Try different locations or a different travel mode.',
  unsupported_mode: 'This travel mode is not supported by the routing provider.',
  rate_limited: 'Routing is busy right now. Try again in a moment.',
  timeout: 'The routing provider did not answer in time. Try again.',
  network: 'We could not reach the routing service. Check your connection and try again.',
  provider: 'The routing provider could not calculate a route.',
};

export function routeError(kind, message) {
  const err = new Error(message || ROUTE_ERROR_COPY[kind] || 'Routing failed.');
  err.name = 'RouteError';
  err.kind = kind;
  return err;
}

// Map the server's typed error codes (plus the client fetcher's own) onto
// the UI's kinds. Unknown codes degrade to `provider` — a real failure with
// honest copy, never a fabricated success.
export function kindFromCode(code) {
  switch (code) {
    case 'no_route':
    case 'unsupported_mode':
    case 'rate_limited':
    case 'timeout':
    case 'invalid_request':
      return code;
    case 'network_error':
      return 'network';
    default:
      return 'provider';
  }
}

// ── location points (the Place adapter seam) ─────────────────────────────

// Turn a chosen result into a validated location point. Accepts the Phase 2
// search result shape ({ lat, lon, name, ... }) — what exists today — and,
// PLACEHOLDER(place-phase): the Phase 3 Place model's `{ location: { lat,
// lng|lon } }` shape, so a Place Detail screen can hand a place over with no
// re-mapping. Returns null for anything unusable; the caller decides whether
// that is an error or a silent skip. Coordinates are never invented here:
// they arrive from search results, device fixes or a Places integration.
export function toLocationPoint(place) {
  if (!place || typeof place !== 'object') return null;
  const rawLat = place.lat != null ? place.lat : place.location && place.location.lat;
  const rawLon = place.lon != null ? place.lon : place.location && (place.location.lon != null ? place.location.lon : place.location.lng);
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  const name = typeof place.name === 'string' ? place.name.trim() : '';
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id: place.id != null ? String(place.id) : null,
    name,
    detail: typeof place.detail === 'string' && place.detail ? place.detail
      : typeof place.addressLine === 'string' && place.addressLine ? place.addressLine
      : null,
    lat,
    lon,
    source: 'place',
  };
}

// Wrap a device fix into a location point. "Current location" is the UI's
// honest label for a device fix — it is not a place name, and nothing
// reverse-geocodes it into one. `accuracy` (metres) is carried when the
// device reported it so the UI can say how precise the fix is.
export function currentLocationPoint(fix) {
  if (!fix || typeof fix !== 'object') return null;
  const lat = Number(fix.lat);
  const lon = Number(fix.lng != null ? fix.lng : fix.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id: null,
    name: 'Current location',
    detail: Number.isFinite(fix.accuracy) && fix.accuracy > 0
      ? `Accurate to about ${Math.round(fix.accuracy)} m`
      : null,
    lat,
    lon,
    source: 'device',
  };
}

// ── session ──────────────────────────────────────────────────────────────

//   fetchRoute(request, { signal }) -> Promise<RouteResult[]>   required
//   capabilities { modes: ['driving'], alternatives, waypoints } required —
//       from /api/config's routing block; the UI trusts the app's own server
//       for which modes are real.
//   mode: initial travel mode; must be in capabilities.modes.
export function createDirectionsSession({ fetchRoute, capabilities, mode = null } = {}) {
  if (typeof fetchRoute !== 'function') {
    throw new Error('createDirectionsSession needs a fetchRoute function.');
  }
  const supported = (capabilities && Array.isArray(capabilities.modes))
    ? capabilities.modes.filter((m) => TRAVEL_MODES[m])
    : [];
  const initialMode = mode && supported.includes(mode) ? mode : supported[0] || null;

  let state = {
    origin: null,
    destination: null,
    waypoints: [], // location points, order = traversal order
    mode: initialMode,
    routes: [], // RouteResult[] as returned; index 0 is the provider's primary
    selectedRoute: 0,
    error: null, // RouteError or null
    pending: false, // a route request is in flight
  };

  const listeners = new Set();
  let controller = null;
  let generation = 0; // ignores completions from a superseded request
  let lastRequest = null; // { request } for Try again

  function snapshot() {
    return { ...state, waypoints: [...state.waypoints] };
  }

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

  function fail(err) {
    state.pending = false;
    state.error = err;
    emit();
  }

  function clearRoutes() {
    state.routes = [];
    state.selectedRoute = 0;
  }

  // The phase the UI renders. Derived, never stored: one source of truth.
  function phase() {
    if (state.pending) return 'routing';
    if (state.error) return 'error';
    if (state.routes.length) return 'routes';
    return 'form';
  }

  function supportedModes() {
    return [...supported];
  }

  function unsupportedModes() {
    return Object.keys(TRAVEL_MODES).filter((m) => !supported.includes(m));
  }

  function waypointsSupported() {
    return Boolean(capabilities && capabilities.waypoints);
  }

  function alternativesSupported() {
    return Boolean(capabilities && capabilities.alternatives);
  }

  // Any change to the request (endpoints, waypoints, mode) invalidates what
  // is on screen: an in-flight request is aborted (and its completion will be
  // ignored even if a fetcher does not honour the abort signal, because the
  // generation moves), and the stale routes/error are dropped. Without this,
  // a swap during routing would leave the old request's geometry standing
  // against the new form.
  function onMutation() {
    generation += 1;
    cancelPending();
    state.pending = false;
    clearRoutes();
    state.error = null;
    emit();
  }

  function setField(key, point) {
    state[key] = point;
    onMutation();
  }

  function validPoint(point) {
    return Boolean(
      point && typeof point === 'object' &&
        Number.isFinite(point.lat) && Number.isFinite(point.lon) && point.name,
    );
  }

  function requestFromState() {
    return {
      origin: state.origin && { lat: state.origin.lat, lon: state.origin.lon },
      destination: state.destination && { lat: state.destination.lat, lon: state.destination.lon },
      waypoints: state.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
      mode: state.mode,
    };
  }

  async function calculate() {
    // Validate BEFORE any network call: a missing endpoint is an immediate,
    // local error state, never a request.
    if (!validPoint(state.origin)) {
      fail(routeError('missing_origin'));
      return;
    }
    if (!validPoint(state.destination)) {
      fail(routeError('missing_destination'));
      return;
    }
    if (!state.mode) {
      fail(routeError('unsupported_mode'));
      return;
    }

    cancelPending();
    generation += 1;
    const gen = generation;
    controller = new AbortController();
    const request = requestFromState();
    lastRequest = { request };
    state.pending = true;
    state.error = null;
    clearRoutes();
    emit();
    try {
      const routes = await fetchRoute(request, { signal: controller.signal });
      if (gen !== generation) return; // a newer request superseded this one
      state.pending = false;
      // Show only what the provider actually returned; an empty answer is a
      // no_route state, never a fabricated route.
      state.routes = Array.isArray(routes) ? routes.filter(Boolean) : [];
      state.selectedRoute = 0;
      if (!state.routes.length) {
        state.error = routeError('no_route');
      }
      emit();
    } catch (err) {
      if (gen !== generation || isAbort(err)) return;
      fail(routeError(kindFromCode(err && err.code), err && err.message));
    }
  }

  function isAbort(err) {
    return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
  }

  function cancelPending() {
    if (controller) controller.abort();
    controller = null;
  }

  function selectRoute(index) {
    if (index < 0 || index >= state.routes.length) return;
    state.selectedRoute = index;
    state.error = null;
    emit();
  }

  function setMode(nextMode) {
    // Only a mode the provider genuinely serves is accepted; an unsupported
    // one leaves the state (and the UI shows it disabled/absent) untouched.
    if (!supported.includes(nextMode) || nextMode === state.mode) return;
    state.mode = nextMode;
    onMutation();
  }

  function addWaypoint(point) {
    if (!waypointsSupported() || !validPoint(point)) return;
    if (state.waypoints.length >= MAX_WAYPOINTS) return;
    state.waypoints.push(point);
    onMutation();
  }

  function removeWaypoint(index) {
    if (index < 0 || index >= state.waypoints.length) return;
    state.waypoints.splice(index, 1);
    onMutation();
  }

  function moveWaypoint(from, to) {
    if (from === to) return;
    if (from < 0 || from >= state.waypoints.length) return;
    if (to < 0 || to >= state.waypoints.length) return;
    const [moved] = state.waypoints.splice(from, 1);
    state.waypoints.splice(to, 0, moved);
    onMutation();
  }

  // One action swaps origin and destination. Valid location data is
  // preserved on both sides; the waypoints reverse too, because
  // "A -> B via W" swapped is "B -> A via W", not "B -> A via reversed-W".
  function swap() {
    const origin = state.origin;
    state.origin = state.destination;
    state.destination = origin;
    state.waypoints.reverse();
    onMutation();
  }

  function clearAll() {
    cancelPending();
    state.origin = null;
    state.destination = null;
    state.waypoints = [];
    state.mode = initialMode;
    clearRoutes();
    state.error = null;
    state.pending = false;
    lastRequest = null;
    emit();
  }

  function retry() {
    if (!lastRequest) return;
    // Re-run whatever was last attempted; validation runs again first, so a
    // request that was refused locally stays refused locally.
    calculate();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: snapshot,
    phase,
    supportedModes,
    unsupportedModes,
    waypointsSupported,
    alternativesSupported,
    modeLabel() {
      return TRAVEL_MODES[state.mode] || null;
    },
    modeLabelOf(mode) {
      return TRAVEL_MODES[mode] || null;
    },
    calculate,
    retry,
    setOrigin: (point) => setField('origin', point),
    setDestination: (point) => setField('destination', point),
    clearOrigin: () => setField('origin', null),
    clearDestination: () => setField('destination', null),
    addWaypoint,
    removeWaypoint,
    moveWaypoint,
    setMode,
    selectRoute,
    swap,
    clearAll,
  };
}

// ── formatting (pure; null-safe) ─────────────────────────────────────────

// Metres -> "450 m" | "12.4 km". Null when the provider gave no distance, so
// the UI can show "Unavailable" instead of a made-up number.
export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return null;
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return `${km >= 100 ? Math.round(km) : Math.round(km * 10) / 10} km`;
}

// Seconds -> "24 min" | "1 h 24 min" | "< 1 min". Null when the provider gave
// no duration — the UI shows "Duration unavailable", never an estimate.
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return '< 1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// The summary line "12.4 km · 24 min". Whichever half the provider did not
// supply reads "unavailable" — the line never invents a value.
export function routeLine(route) {
  const distance = formatDistance(route && route.distance) || 'Distance unavailable';
  const duration = formatDuration(route && route.duration) || 'Duration unavailable';
  return `${distance} · ${duration}`;
}

// Geographic bounds of a route geometry, for the map's fit-to-route. Pure
// view math over real provider coordinates; null for unusable geometry.
export function geometryBounds(coords) {
  if (!Array.isArray(coords) || !coords.length) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const pt of coords) {
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    if (pt[0] < west) west = pt[0];
    if (pt[0] > east) east = pt[0];
    if (pt[1] < south) south = pt[1];
    if (pt[1] > north) north = pt[1];
  }
  if (![west, east, south, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}
