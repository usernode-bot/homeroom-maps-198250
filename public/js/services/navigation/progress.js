// Pure route-progress math for navigation — the geometry half of Phase 8.
//
// Everything here is synchronous and I/O-free so node:test can drive it. It
// measures against data the routing provider actually returned (the overview
// geometry, step maneuver locations, step distances and durations); it never
// invents a coordinate, a distance or a duration. Where a measurement is not
// possible (a maneuver location that cannot be placed on the drawn line, a
// route with no steps) the result is null and the UI shows "unavailable".
//
// Coordinates follow the normalized RouteResult convention: geometry points
// are [lng, lat]; fixes are { lat, lng, accuracy }.
'use strict';

const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;

// Great-circle distance between two lat/lng points, in metres.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Local equirectangular metric space around a reference latitude: good to
// well under a metre over city-scale segments, and cheap enough to run per fix.
function toXY(lng, lat, refLat) {
  return {
    x: lng * DEG * EARTH_RADIUS_M * Math.cos(refLat * DEG),
    y: lat * DEG * EARTH_RADIUS_M,
  };
}

// A route geometry prepared for projection: cached cumulative segment lengths
// so each fix is O(local window) work instead of a full rescan.
export function createRouteTracker(coords) {
  if (!Array.isArray(coords)) return null;
  const pts = coords.filter(
    (pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
  );
  if (pts.length < 2) return null;

  // cumulative[i] = distance from the first point to the start of segment i
  const cumulative = [0];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = toXY(pts[i][0], pts[i][1], pts[i][1]);
    const b = toXY(pts[i + 1][0], pts[i + 1][1], pts[i][1]);
    cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const totalMeters = cumulative[cumulative.length - 1];

  const last = pts[pts.length - 1];

  // Project (lat, lng) onto segment i. Returns null past the ends only via
  // clamping — projection always yields a point on the segment.
  function projectOnSegment(i, lat, lng) {
    const refLat = pts[i][1];
    const a = toXY(pts[i][0], pts[i][1], refLat);
    const b = toXY(pts[i + 1][0], pts[i + 1][1], refLat);
    const p = toXY(lng, lat, refLat);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const qx = a.x + t * dx;
    const qy = a.y + t * dy;
    const segLen = Math.sqrt(len2);
    return {
      segmentIndex: i,
      t,
      offRouteMeters: Math.hypot(p.x - qx, p.y - qy),
      positionMeters: cumulative[i] + t * segLen,
      point: [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])],
    };
  }

  // Windowed projection around the hint segment, with a full rescan when the
  // windowed best is poor (the fix jumped, or the hint went stale).
  const WINDOW = 25;
  const FULL_SCAN_THRESHOLD_M = 150;

  function project(lat, lng, hintIndex = 0) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const segments = pts.length - 1;
    let from = Math.max(0, Math.min(segments - 1, (hintIndex | 0) - WINDOW));
    let to = Math.max(0, Math.min(segments - 1, (hintIndex | 0) + WINDOW));
    let best = null;
    for (let i = from; i <= to; i += 1) {
      const cand = projectOnSegment(i, lat, lng);
      if (!best || cand.offRouteMeters < best.offRouteMeters) best = cand;
    }
    if (best && best.offRouteMeters > FULL_SCAN_THRESHOLD_M && (from > 0 || to < segments - 1)) {
      best = null;
      for (let i = 0; i < segments; i += 1) {
        const cand = projectOnSegment(i, lat, lng);
        if (!best || cand.offRouteMeters < best.offRouteMeters) best = cand;
      }
    }
    return best;
  }

  return {
    coords: pts,
    totalMeters,
    project,
    // The route's end point, [lng, lat] — the geometry-side arrival target.
    endPoint: [last[0], last[1]],
  };
}

// Place every step's maneuver location on the drawn line so maneuvers can be
// distance-addressed. A step whose maneuver has no usable location, or whose
// location lands too far from the (simplified) overview line to measure
// honestly, keeps distanceFromStart null — the UI then shows the maneuver
// without a distance rather than a guessed one.
const MANEUVER_PLACEMENT_MAX_M = 100;

export function buildManeuverSchedule(tracker, route) {
  const items = [];
  const legs = (route && Array.isArray(route.legs)) ? route.legs : [];
  for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
    const steps = (legs[legIndex] && Array.isArray(legs[legIndex].steps)) ? legs[legIndex].steps : [];
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      const loc = step && step.maneuver && Array.isArray(step.maneuver.location) ? step.maneuver.location : null;
      let distanceFromStart = null;
      if (loc && Number.isFinite(loc[0]) && Number.isFinite(loc[1])) {
        const proj = tracker ? tracker.project(loc[1], loc[0], 0) : null;
        if (proj && proj.offRouteMeters <= MANEUVER_PLACEMENT_MAX_M) {
          distanceFromStart = proj.positionMeters;
        }
      }
      items.push({ legIndex, stepIndex, step, distanceFromStart });
    }
  }
  return items;
}

// One fix's position on the route, as scalars the session snapshot carries.
// `remainingDurationSeconds` is null unless EVERY step that carries a duration
// could be placed on the line — a partially measurable route would make a
// partly invented sum, so it is unavailable instead.
export function computeRouteProgress({ tracker, route, fix, proj, schedule = [], aheadBufferMeters = 5 }) {
  if (!tracker || !fix || !proj) return null;
  const providerDistance = route && Number.isFinite(route.distance) ? route.distance : null;
  const totalDistanceMeters = providerDistance != null ? providerDistance : tracker.totalMeters;
  const positionMeters = proj.positionMeters;
  const remainingDistanceMeters = Math.max(0, totalDistanceMeters - positionMeters);

  const stepsUsable =
    schedule.length > 0 &&
    schedule.every((item) => !Number.isFinite(item.step && item.step.duration) || item.distanceFromStart != null);
  let remainingDurationSeconds = null;
  if (stepsUsable) {
    let sum = 0;
    for (const item of schedule) {
      if (item.distanceFromStart == null) continue;
      if (item.distanceFromStart > positionMeters + aheadBufferMeters) {
        sum += Number.isFinite(item.step.duration) ? item.step.duration : 0;
      }
    }
    remainingDurationSeconds = sum;
  }

  let nextManeuver = null;
  let followingManeuver = null;
  for (const item of schedule) {
    if (item.distanceFromStart == null) continue;
    if (!nextManeuver && item.distanceFromStart > positionMeters + aheadBufferMeters) {
      nextManeuver = {
        step: item.step,
        legIndex: item.legIndex,
        stepIndex: item.stepIndex,
        distanceMeters: item.distanceFromStart - positionMeters,
      };
      continue;
    }
    if (nextManeuver) {
      followingManeuver = { step: item.step, legIndex: item.legIndex, stepIndex: item.stepIndex };
      break;
    }
  }

  return {
    positionMeters,
    totalDistanceMeters,
    remainingDistanceMeters,
    remainingDurationSeconds,
    offRouteMeters: proj.offRouteMeters,
    segmentIndex: proj.segmentIndex,
    snapPoint: proj.point,
    nextManeuver,
    followingManeuver,
  };
}

// The not-yet-travelled part of the drawn line, for display only: the snapped
// point followed by the rest of the provider geometry. The session's route
// data is never mutated; if this yields something undrawable the caller falls
// back to the full line.
export function remainingGeometry(coords, proj) {
  if (!Array.isArray(coords) || !proj || !Array.isArray(proj.point)) return null;
  const idx = Math.max(0, Math.min(coords.length - 1, proj.segmentIndex + 1));
  const rest = coords.slice(idx);
  const line = [proj.point, ...rest];
  return line.length >= 2 ? line : null;
}

// Arrival: the fix is within the arrival radius (widened by the fix's own
// reported accuracy) of the destination point or of the route geometry's end
// — whichever is closer. Elapsed time is never an input.
export function isArrived(fix, destination, geometryEnd, radiusMeters = 30) {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return false;
  const radius = radiusMeters + (Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : 0);
  let best = null;
  if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lon)) {
    best = haversineMeters(fix.lat, fix.lng, destination.lat, destination.lon);
  }
  if (Array.isArray(geometryEnd) && Number.isFinite(geometryEnd[0]) && Number.isFinite(geometryEnd[1])) {
    const d = haversineMeters(fix.lat, fix.lng, geometryEnd[1], geometryEnd[0]);
    if (best == null || (d != null && d < best)) best = d;
  }
  return best != null && best <= radius;
}