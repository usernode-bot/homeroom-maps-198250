// Pure normalization and validation for the routing service.
//
// Everything here is synchronous and I/O-free so it is fully unit-testable.
// The pipeline (routing/index.js) calls validateRouteRequest() as the FIRST
// step, so no malformed request ever reaches an adapter, and every adapter
// calls normalizeRoute() as the LAST step before returning, which guarantees
// the normalized RouteResult shape is the only shape that leaves this module
// — no provider-specific field can leak past it.
//
// NOTHING here invents values. A route the provider did not return does not
// exist; a field the provider did not supply stays null or empty, and the UI
// shows "Unavailable" for it.
'use strict';

const { routingError } = require('./provider');

// The travel modes the app models. Which of them the ACTIVE provider serves
// is the adapter's capabilities, never this list.
const TRAVEL_MODES = ['driving', 'walking', 'cycling', 'motorcycle', 'transit'];

// Cap on intermediate stops. Waypoints are supported by every evaluated
// engine; the cap keeps a single request inside the public demo server's
// reasonable-use envelope and inside a sane URL length.
const MAX_WAYPOINTS = 5;

// English labels for the UI. The app is English-only.
const MODE_LABELS = {
  driving: 'Driving',
  walking: 'Walking',
  cycling: 'Cycling',
  motorcycle: 'Motorcycle',
  transit: 'Transit',
};

// Parse one "lat,lon" pair. Rejects anything malformed, out of range, or
// suspiciously precise-free (a bare 0,0 is a valid coordinate but is almost
// always a placeholder; it is not refused — coordinates come from search
// results or the device, and refusing zeros would break legitimate equatorial
// points. Only genuine malformation is refused).
function parseLatLng(raw, label) {
  if (raw == null || raw === '') {
    throw routingError('invalid_request', `${label} is missing.`);
  }
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw routingError('invalid_request', `${label} is malformed.`);
  }
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw routingError('invalid_request', `${label} is out of range.`);
  }
  return { lat, lon };
}

// Parse "lat,lon|lat,lon|..." into waypoint points. Absent is an empty list;
// malformed or over-cap throws.
function parseWaypoints(raw) {
  if (raw == null || raw === '') return [];
  const parts = String(raw).split('|');
  if (parts.length > MAX_WAYPOINTS) {
    throw routingError(
      'invalid_request',
      `At most ${MAX_WAYPOINTS} waypoints are supported.`,
    );
  }
  return parts.map((p, i) => parseLatLng(p, `Waypoint ${i + 1}`));
}

// Normalize the requested travel mode. Absent defaults to driving; an unknown
// value is a bad request, not a silent fallback — the UI only sends values
// from the same list, so an unknown one means a caller bug.
function normalizeMode(raw) {
  if (raw == null || raw === '') return 'driving';
  const mode = String(raw).trim().toLowerCase();
  if (!TRAVEL_MODES.includes(mode)) {
    throw routingError('invalid_request', `Unknown travel mode "${raw}".`);
  }
  return mode;
}

// Validate and shape the raw HTTP params into the normalized route request:
//   { origin: {lat, lon}, destination: {lat, lon}, waypoints: [...], mode }
function validateRouteRequest(params = {}) {
  return {
    origin: parseLatLng(params.origin, 'The origin'),
    destination: parseLatLng(params.destination, 'The destination'),
    waypoints: parseWaypoints(params.waypoints),
    mode: normalizeMode(params.mode),
  };
}

// Final guard over one provider route. Returns null for anything unusable
// (the pipeline skips those silently — a provider that reports three routes
// where one has no geometry yields two, not a fabricated third) and fills
// every optional field, so the UI never reads `undefined` off a result.
//
// Shape (provider-independent, Phase 8 navigation reads the same fields):
//   geometry         [[lng, lat], ...] the drawn line, real provider data
//   distance         metres (number), null when the provider gave none
//   duration         seconds (number), null when the provider gave none —
//                    the UI shows "Duration unavailable", never an estimate
//   summary          the provider's own summary string, null when none
//   restrictions     array of restriction strings; empty when the provider
//                    surfaced none (NOT an assertion that the road is clear)
//   roadInformation  array of road names the provider's steps carried, in
//                    order; empty when the provider gave none
//   legs             per-leg detail for the later navigation phase:
//                    [{ distance, duration, steps: [{ name, ref, distance,
//                    duration, maneuver: { type, modifier, location } }] }]
//   provider         the adapter's name
function normalizeRoute(partial, providerName) {
  if (!partial || typeof partial !== 'object') return null;
  const geometry = Array.isArray(partial.geometry)
    ? partial.geometry.filter(
        (pt) => Array.isArray(pt) && pt.length >= 2 &&
          Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
      )
    : [];
  if (!geometry.length) return null;

  const distance = Number.isFinite(partial.distance) && partial.distance >= 0
    ? partial.distance
    : null;
  const duration = Number.isFinite(partial.duration) && partial.duration >= 0
    ? partial.duration
    : null;

  const legs = Array.isArray(partial.legs)
    ? partial.legs.map((leg) => normalizeLeg(leg)).filter(Boolean)
    : [];

  return {
    geometry,
    distance,
    duration,
    summary: typeof partial.summary === 'string' && partial.summary.trim()
      ? partial.summary.trim()
      : null,
    restrictions: Array.isArray(partial.restrictions)
      ? partial.restrictions.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : [],
    roadInformation: Array.isArray(partial.roadInformation)
      ? partial.roadInformation.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : [],
    legs,
    provider: String(providerName || 'unknown'),
  };
}

// One leg. Steps keep the maneuver facts the navigation phase will need
// (type, modifier, location) plus the step's own road name and length. Step
// geometry is deliberately NOT carried: the route line already renders from
// the overview geometry, and shipping every step's polyline would triple the
// payload. TODO(navigation-phase): re-request per-step geometry when live
// guidance needs it.
function normalizeLeg(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const distance = Number.isFinite(leg.distance) && leg.distance >= 0 ? leg.distance : null;
  const duration = Number.isFinite(leg.duration) && leg.duration >= 0 ? leg.duration : null;
  const steps = Array.isArray(leg.steps)
    ? leg.steps.map((step) => normalizeStep(step)).filter(Boolean)
    : [];
  return { distance, duration, steps };
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const m = step.maneuver || {};
  const maneuver = {
    type: typeof m.type === 'string' ? m.type : null,
    modifier: typeof m.modifier === 'string' ? m.modifier : null,
    location: Array.isArray(m.location) &&
      m.location.length >= 2 &&
      m.location.every(Number.isFinite)
      ? [m.location[0], m.location[1]]
      : null,
  };
  return {
    name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : null,
    ref: typeof step.ref === 'string' && step.ref.trim() ? step.ref.trim() : null,
    distance: Number.isFinite(step.distance) && step.distance >= 0 ? step.distance : null,
    duration: Number.isFinite(step.duration) && step.duration >= 0 ? step.duration : null,
    // Roundabout exit number, when the provider's maneuver carries one (OSRM
    // supplies `exit` for roundabout/rotary steps). Navigation uses it so a
    // roundabout instruction can say which exit; a step without one keeps
    // null and the instruction honestly omits it. TODO(navigation-phase)
    // carried the per-step geometry drop; this field is the additive part
    // live guidance needed from the same response.
    exit: Number.isFinite(step.exit) && step.exit > 0 ? step.exit : null,
    maneuver,
  };
}

// Collect the road names a route's steps actually carried, in traversal
// order, collapsing consecutive repeats ("A 100, A 100, B 2" -> "A 100, B 2").
// Derived strictly from provider data; an unstepped route yields [].
function roadNamesOf(legs) {
  const names = [];
  for (const leg of legs) {
    for (const step of leg.steps) {
      const name = step.name || step.ref;
      if (!name) continue;
      if (names.length && names[names.length - 1] === name) continue;
      names.push(name);
    }
  }
  return names;
}

module.exports = {
  TRAVEL_MODES,
  MODE_LABELS,
  MAX_WAYPOINTS,
  parseLatLng,
  parseWaypoints,
  normalizeMode,
  validateRouteRequest,
  normalizeRoute,
  normalizeLeg,
  normalizeStep,
  roadNamesOf,
};
