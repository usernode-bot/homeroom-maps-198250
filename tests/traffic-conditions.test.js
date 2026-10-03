// Tests for the route traffic derivation (public/js/services/traffic.js),
// the pure module behind request #26 (traffic conditions on route paths).
// The module is pure, import-free ESM, so node:test drives it directly via a
// dynamic import — the same convention as tests/directions-session.test.js.
// Covered: which reports still count as an active jam, the per-segment
// corridor match, the piece tiling (jammed and flowing pieces share their
// boundary vertices so the overlay tiles the drawn line exactly), the
// coverage query the screen issues, and the honest no-data shapes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let traffic;

before(async () => {
  traffic = await import('../public/js/services/traffic.js');
});

// A vertical test line near Berlin, ~1105 m per degree of latitude.
const LINE = [
  [13.4, 52.5],
  [13.4, 52.51],
  [13.4, 52.52],
];

function jamReport(overrides = {}) {
  return {
    id: 1,
    type: 'traffic',
    lat: 52.505,
    lng: 13.4,
    status: 'verified',
    effectiveStatus: 'active',
    ...overrides,
  };
}

test('activeJamReports keeps jam-capable types with valid coordinates', () => {
  const kept = traffic.activeJamReports([
    jamReport({ id: 1, type: 'traffic' }),
    jamReport({ id: 2, type: 'accident' }),
    jamReport({ id: 3, type: 'road_closed' }),
    jamReport({ id: 4, type: 'construction' }),
    jamReport({ id: 5, type: 'flood' }),
    jamReport({ id: 6, type: 'fire' }),
  ]);
  assert.deepEqual(kept.map((r) => r.id), [1, 2, 3, 4, 5, 6]);
});

test('activeJamReports drops rejected and expired reports and non-jam types', () => {
  const kept = traffic.activeJamReports([
    jamReport({ id: 1, status: 'rejected' }),
    jamReport({ id: 2, effectiveStatus: 'expired' }),
    jamReport({ id: 3, type: 'hazard' }),
    jamReport({ id: 4, type: 'broken_road' }),
    jamReport({ id: 5, type: 'other' }),
    jamReport({ id: 6, lat: Number.NaN }),
    jamReport({ id: 7, lng: 999 }),
    'not an object',
    null,
  ]);
  assert.deepEqual(kept.map((r) => r && r.id).filter(Boolean), []);
});

test('activeJamReports tolerates a non-array feed', () => {
  assert.deepEqual(traffic.activeJamReports(null), []);
  assert.deepEqual(traffic.activeJamReports(undefined), []);
});

test('a report on the line marks exactly that segment jammed, with shared boundary vertices', () => {
  const { flowing, jammed, reportsOnRoute } = traffic.routeConditions(LINE, [
    jamReport({ lat: 52.505 }),
  ]);
  // Segment 0 (vertices 0..1) is jammed; segment 1 keeps flowing.
  assert.deepEqual(jammed, [[[13.4, 52.5], [13.4, 52.51]]]);
  assert.deepEqual(flowing, [[[13.4, 52.51], [13.4, 52.52]]]);
  // The pieces tile the original line: shared boundary vertices, same order.
  assert.equal(jammed[0][1][1], LINE[1][1]);
  assert.equal(flowing[0][0][1], LINE[1][1]);
  assert.equal(flowing[0][1][1], LINE[2][1]);
  assert.equal(reportsOnRoute.length, 1);
});

test('a report within the corridor but slightly off the centreline still marks a jam', () => {
  // ~135 m east of the line at this latitude: inside the 150 m corridor.
  const { jammed } = traffic.routeConditions(LINE, [
    jamReport({ lat: 52.505, lng: 13.402 }),
  ]);
  assert.equal(jammed.length, 1);
});

test('a report beyond the corridor leaves the whole line flowing', () => {
  // ~270 m east of the line: outside the 150 m corridor.
  const { flowing, jammed } = traffic.routeConditions(LINE, [
    jamReport({ lat: 52.505, lng: 13.404 }),
  ]);
  assert.deepEqual(jammed, []);
  assert.deepEqual(flowing, [LINE]);
});

test('adjacent jammed segments merge into one piece; separated ones stay two', () => {
  const adjacent = traffic.routeConditions(
    LINE,
    [jamReport({ lat: 52.505 }), jamReport({ lat: 52.515 })],
  );
  assert.equal(adjacent.jammed.length, 1);
  assert.equal(adjacent.jammed[0].length, 3); // vertices 0..2, the whole line
  assert.deepEqual(adjacent.flowing, []); // nothing left flowing

  const separated = traffic.routeConditions(
    [
      [13.4, 52.5],
      [13.4, 52.505],
      [13.4, 52.51],
      [13.4, 52.515],
      [13.4, 52.52],
    ],
    [jamReport({ lat: 52.5025 }), jamReport({ lat: 52.5175 })],
  );
  assert.equal(separated.jammed.length, 2);
  assert.equal(separated.flowing.length, 1); // the two middle segments
});

test('a jam at either end produces a flowing run only where line remains', () => {
  const atStart = traffic.routeConditions(LINE, [jamReport({ lat: 52.5001 })]);
  assert.deepEqual(atStart.jammed, [[[13.4, 52.5], [13.4, 52.51]]]);
  assert.deepEqual(atStart.flowing, [[[13.4, 52.51], [13.4, 52.52]]]);

  const atEnd = traffic.routeConditions(LINE, [jamReport({ lat: 52.5199 })]);
  assert.deepEqual(atEnd.flowing, [[[13.4, 52.5], [13.4, 52.51]]]);
});

test('no reports at all means the whole line flows and nothing is invented', () => {
  const { flowing, jammed, reportsOnRoute } = traffic.routeConditions(LINE, []);
  assert.deepEqual(flowing, [LINE]);
  assert.deepEqual(jammed, []);
  assert.deepEqual(reportsOnRoute, []);

  const emptyGeometry = traffic.routeConditions([], [jamReport()]);
  assert.deepEqual(emptyGeometry.flowing, []);
  assert.deepEqual(emptyGeometry.jammed, []);

  const tooShort = traffic.routeConditions([[13.4, 52.5]], [jamReport()]);
  assert.deepEqual(tooShort.flowing, [[[13.4, 52.5]]]);
  assert.deepEqual(tooShort.jammed, []);
});

test('malformed vertices are dropped from the drawn line', () => {
  const messy = [
    [13.4, 52.5],
    [13.4, Number.NaN],
    [13.4, 52.52],
  ];
  const { flowing } = traffic.routeConditions(messy, []);
  assert.equal(flowing.length, 1);
  assert.deepEqual(flowing[0], [
    [13.4, 52.5],
    [13.4, 52.52],
  ]);
});

test('the corridor width is overridable and defaults to 150 m', () => {
  assert.equal(traffic.JAM_CORRIDOR_METERS, 150);
  // ~270 m off the line: outside the default corridor, inside a 300 m one.
  const opts = { corridorMeters: 300 };
  const { jammed } = traffic.routeConditions(
    LINE,
    [jamReport({ lat: 52.505, lng: 13.404 })],
    opts,
  );
  assert.equal(jammed.length, 1);
});

test('coverageForGeometry centres the query on the bounds and reaches every vertex', () => {
  const coverage = traffic.coverageForGeometry(LINE);
  assert.ok(Math.abs(coverage.near.lat - 52.51) < 1e-9);
  assert.equal(coverage.near.lng, 13.4);
  // Farthest vertex is ~1105 m from the centre; plus the 150 m corridor,
  // ceil(1.255) = 2 km.
  assert.equal(coverage.radiusKm, 2);
});

test('coverageForGeometry returns null for unusable geometry', () => {
  assert.equal(traffic.coverageForGeometry([]), null);
  assert.equal(traffic.coverageForGeometry([[13.4, 52.5]]), null);
  assert.equal(traffic.coverageForGeometry(null), null);
});

test('distanceMeters measures known great-circle distances', () => {
  // One degree of latitude is ~111.2 km.
  const d = traffic.distanceMeters([13.4, 52.5], [13.4, 53.5]);
  assert.ok(Math.abs(d - 111200) < 500, `expected ~111200 m, got ${d}`);
  assert.equal(traffic.distanceMeters(null, [13.4, 52.5]), null);
});

test('the jam colours are the shared constants the map and legend both use', () => {
  assert.equal(traffic.TRAFFIC_JAM_COLOR, '#dc2626');
  assert.equal(traffic.TRAFFIC_JAM_CASING_COLOR, '#7f1d1d');
  assert.equal(traffic.TRAFFIC_CLEAR_COLOR, '#4f46e5');
});
