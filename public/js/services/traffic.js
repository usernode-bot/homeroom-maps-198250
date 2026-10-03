// Route traffic conditions — the pure, import-free derivation behind the
// Directions traffic colours (request #26).
//
// This app has NO live traffic feed: the default routing provider is OSRM,
// whose `capabilities.traffic` is false, and no traffic provider is connected
// (see config.js and docs/wave-5-master-spec.md — a live provider is the
// later Phase 12D). The one traffic data source the app already has is the
// community reports feed (Phase 6), which carries a Traffic report type plus
// the other types that mean the road itself is obstructed. This module turns
// that feed into the per-segment condition of a displayed route:
//
//   jammed   — an active jam report sits within the corridor of this part of
//              the drawn line; the map draws these stretches in red
//   flowing  — no active jam report sits within the corridor here; these
//              stretches keep the route's normal colour
//
// Nothing is fabricated: a stretch only reads "jammed" when a real, current,
// non-rejected community report says so, and the UI's legend labels the other
// state "No jam reported" rather than claiming confirmed free flow. The
// corridor is the drawn line's own segments (the simplified overview
// geometry the map draws), so the colours always match the path on screen.
//
// Shared presentation constants: the map layers (map/maplibre.js) and the
// legend (screens/directions.js) must show the same colours.
'use strict';

// Report types that describe the road being obstructed or slowed — the ones
// a traffic jam can be honestly derived from. `hazard` and `broken_road` are
// deliberately left out (a footpath slab or a rough surface does not jam
// traffic), as are `wrong_map_data`, `place_closed` and `other`.
export const JAM_REPORT_TYPES = [
  'traffic',
  'accident',
  'road_closed',
  'construction',
  'flood',
  'fire',
];

// How far from the drawn line a report still counts as sitting on it. A
// report is a point on the road; the corridor covers the line's own
// simplification offset plus a report placed slightly off the centreline.
export const JAM_CORRIDOR_METERS = 150;

// The jam overlay's colours: the app's danger red for the jammed stretch,
// with its darker casing, matching the palette the route line already uses
// (styles/tailwind-input.css --hm-danger family). Flowing stretches keep the
// route's own colours; the legend's "no jam" swatch mirrors that colour
// (maplibre.js ROUTE_COLOR) so both always read the same.
export const TRAFFIC_JAM_COLOR = '#dc2626';
export const TRAFFIC_JAM_CASING_COLOR = '#7f1d1d';
export const TRAFFIC_CLEAR_COLOR = '#4f46e5';

// The feed items that still mark a jam: a jam-capable type, finite
// coordinates, and neither derived-expired nor reviewer-rejected (a
// rejection is a standing answer that the report is not true). `status`
// guards against a feed shape without `effectiveStatus`.
export function activeJamReports(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (r) =>
      r &&
      typeof r === 'object' &&
      JAM_REPORT_TYPES.includes(r.type) &&
      r.status !== 'rejected' &&
      r.effectiveStatus !== 'expired' &&
      Number.isFinite(r.lat) &&
      Number.isFinite(r.lng) &&
      Math.abs(r.lat) <= 90 &&
      Math.abs(r.lng) <= 180,
  );
}

// Great-circle distance in metres between two [lng, lat] points (haversine).
export function distanceMeters(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Distance in metres from a point to a segment, on a local equirectangular
// projection around the segment's start. Accurate well beyond the corridor
// scale at every zoom a route is judged at; the antimeridian is not handled
// (a route crossing ±180° would misjudge its far side — the same limitation
// the bounds-based camera fit already accepts).
function segmentDistanceMeters(p, a, b) {
  const latRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const metersPerDegX = 111320 * Math.cos(latRad);
  const metersPerDegY = 110540;
  const px = (p[0] - a[0]) * metersPerDegX;
  const py = (p[1] - a[1]) * metersPerDegY;
  const bx = (b[0] - a[0]) * metersPerDegX;
  const by = (b[1] - a[1]) * metersPerDegY;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - bx * t, py - by * t);
}

// The per-segment condition of one drawn route line against the active jam
// reports. Returns pieces cut so they share their boundary vertices — drawn
// in the same order they are returned, the pieces tile the original line
// with no gap and no gap-filling overlap beyond a shared vertex:
//
//   {
//     flowing: [ [[lng, lat], ...], ... ],  pieces drawn with the route's
//                                           normal styling, in traversal order
//     jammed:  [ [[lng, lat], ...], ... ],  pieces the map draws in red (possibly
//                                           empty — no report on this route)
//     reportsOnRoute: [ report, ... ],      the reports that matched
//   }
//
// A jam run [s..e] of SEGMENT indices spans vertices s..e+1; the adjacent
// flowing runs end and begin on those same boundary vertices.
export function routeConditions(geometry, jamReports, opts = {}) {
  const corridorMeters =
    Number.isFinite(opts.corridorMeters) && opts.corridorMeters > 0
      ? opts.corridorMeters
      : JAM_CORRIDOR_METERS;
  const line = (Array.isArray(geometry) ? geometry : []).filter(
    (pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
  );
  const reports = activeJamReports(jamReports);
  if (line.length < 2 || !reports.length) {
    return { flowing: line.length ? [line] : [], jammed: [], reportsOnRoute: [] };
  }

  // Flag each drawn segment that a report sits within the corridor of, and
  // remember which reports did the flagging.
  const jammedSeg = new Array(line.length - 1).fill(false);
  const onRoute = new Set();
  for (let i = 0; i < jammedSeg.length; i += 1) {
    for (const report of reports) {
      const d = segmentDistanceMeters([report.lng, report.lat], line[i], line[i + 1]);
      if (d <= corridorMeters) {
        jammedSeg[i] = true;
        onRoute.add(report);
      }
    }
  }

  const pieces = maximalRuns(jammedSeg, true).map((run) =>
    line.slice(run.start, run.end + 2),
  );
  const flowing =
    pieces.length === 0
      ? [line]
      : maximalRuns(jammedSeg, false).map((run) => line.slice(run.start, run.end + 2));
  return { flowing, jammed: pieces, reportsOnRoute: [...onRoute] };
}

// Maximal runs of one flag value over the segment array, as { start, end }
// in segment indices. Empty when the value never occurs.
function maximalRuns(flags, value) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === value) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: flags.length - 1 });
  return runs;
}

// Where to centre the reports query so one Nearby request covers the route:
// the bounds centre, and a radius that reaches every drawn vertex plus the
// corridor. The server clamps the radius to its own cap (200 km), so routes
// longer than that check only their middle — the colours stay honest by
// omission (no report fetched, no jam claimed), never by invention.
export function coverageForGeometry(geometry) {
  const line = (Array.isArray(geometry) ? geometry : []).filter(
    (pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
  );
  if (line.length < 2) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lng, lat] of line) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const near = { lat: (south + north) / 2, lng: (west + east) / 2 };
  let radiusKm = 0;
  for (const pt of line) {
    const d = distanceMeters([near.lng, near.lat], pt);
    if (Number.isFinite(d)) radiusKm = Math.max(radiusKm, d / 1000);
  }
  return { near, radiusKm: Math.ceil(radiusKm + JAM_CORRIDOR_METERS / 1000) };
}
