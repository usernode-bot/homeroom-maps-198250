// Tests for the pure route-progress math behind navigation
// (public/js/services/navigation/progress.js). The module is dependency-free
// ESM, loaded via dynamic import like the other client-module tests.
//
// The honesty contract is the thread through every case: measurements come
// only from data the routing provider returned (geometry, step locations,
// step distances/durations); anything unmeasurable is null, never estimated.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let haversineMeters;
let createRouteTracker;
let buildManeuverSchedule;
let computeRouteProgress;
let remainingGeometry;
let isArrived;

before(async () => {
  const mod = await import('../public/js/services/navigation/progress.js');
  ({
    haversineMeters,
    createRouteTracker,
    buildManeuverSchedule,
    computeRouteProgress,
    remainingGeometry,
    isArrived,
  } = mod);
});

// A simple 4-point square route around (52.52, 13.405), ~100 m per side.
// geometry is [lng, lat] per the normalized RouteResult convention.
const GEOMETRY = [
  [13.405, 52.52],
  [13.405, 52.5209],
  [13.4062, 52.5209],
  [13.4062, 52.52],
];

// The route for the schedule/progress helpers: legs and steps in the
// normalized shape, with maneuver locations that land on the line.
const ROUTE = {
  geometry: GEOMETRY,
  distance: null,
  duration: null,
  legs: [
    {
      distance: null,
      duration: null,
      steps: [
        {
          name: 'First Street',
          distance: 100,
          duration: 30,
          maneuver: { type: 'depart', modifier: null, location: [13.405, 52.52] },
        },
        {
          name: 'Second Street',
          distance: 100,
          duration: 30,
          maneuver: { type: 'turn', modifier: 'right', location: [13.405, 52.5209] },
        },
        {
          name: null,
          distance: 100,
          duration: null,
          maneuver: { type: 'arrive', modifier: null, location: [13.4062, 52.52] },
        },
      ],
    },
  ],
};

test('haversineMeters measures real great-circle distances', () => {
  // Berlin (52.52, 13.405) -> Amsterdam (52.3676, 4.9041) is ~577 km.
  const d = haversineMeters(52.52, 13.405, 52.3676, 4.9041);
  assert.ok(d > 550000 && d < 600000, `distance ${d} in a plausible range`);
  assert.equal(haversineMeters(52.52, 13.405, 52.52, 13.405), 0);
  assert.equal(haversineMeters(NaN, 13.405, 52.52, 13.405), null);
});

test('createRouteTracker refuses unusable geometry', () => {
  assert.equal(createRouteTracker(null), null);
  assert.equal(createRouteTracker([]), null);
  assert.equal(createRouteTracker([[13.405, 52.52]]), null);
  assert.equal(createRouteTracker([[13.405, 'x'], [13.406, 52.52]]), null);
});

test('projection places a fix on the line and reports its deviation', () => {
  const tracker = createRouteTracker(GEOMETRY);
  // Exactly on the first segment (halfway up the west side).
  const on = tracker.project(52.52045, 13.405, 0);
  assert.equal(on.segmentIndex, 0);
  assert.equal(on.offRouteMeters < 0.5, true);
  assert.ok(on.positionMeters > 40 && on.positionMeters < 60, `position ${on.positionMeters}`);

  // Well east of the line: off-route distance reads in metres.
  const off = tracker.project(52.5209, 13.410, 0);
  assert.ok(off.offRouteMeters > 200, `off-route ${off.offRouteMeters} m east`);
  assert.equal(off.segmentIndex, 1); // nearest to the east-west top segment
});

test('projection windows around the hint but rescans when the fix jumped', () => {
  const tracker = createRouteTracker(GEOMETRY);
  // Hint far from the actual position, but within the rescan safety net.
  const jumped = tracker.project(52.52, 13.4062, 0);
  assert.ok(jumped.offRouteMeters < 1, `jumped fix lands on the line: ${jumped.offRouteMeters}`);
  assert.equal(jumped.positionMeters, tracker.totalMeters); // clamped to the end
});

test('buildManeuverSchedule places steps whose location lands on the line', () => {
  const tracker = createRouteTracker(GEOMETRY);
  const schedule = buildManeuverSchedule(tracker, ROUTE);
  assert.equal(schedule.length, 3);
  assert.equal(schedule[0].legIndex, 0);
  assert.equal(schedule[0].stepIndex, 0);
  assert.ok(schedule[0].distanceFromStart === 0, `depart at the start: ${schedule[0].distanceFromStart}`);
  assert.ok(schedule[1].distanceFromStart > 90 && schedule[1].distanceFromStart < 110,
    `turn at the first corner: ${schedule[1].distanceFromStart}`);
  assert.ok(schedule[2].distanceFromStart > 270 && schedule[2].distanceFromStart < 292,
    `arrive at the end: ${schedule[2].distanceFromStart}`);
});

test('a maneuver location too far from the drawn line keeps no distance', () => {
  const tracker = createRouteTracker(GEOMETRY);
  const offRoute = {
    geometry: GEOMETRY,
    legs: [{ steps: [{ name: 'X', distance: 100, duration: 30, maneuver: { type: 'turn', modifier: 'left', location: [13.5, 52.52] } }] }],
  };
  const schedule = buildManeuverSchedule(tracker, offRoute);
  assert.equal(schedule[0].distanceFromStart, null);
});

test('computeRouteProgress reports remaining distance and next maneuver', () => {
  const tracker = createRouteTracker(GEOMETRY);
  const schedule = buildManeuverSchedule(tracker, ROUTE);
  // Halfway up the first side.
  const fix = { lat: 52.52045, lng: 13.405, accuracy: 10 };
  const proj = tracker.project(fix.lat, fix.lng, 0);
  const progress = computeRouteProgress({ tracker, route: ROUTE, fix, proj, schedule });

  assert.ok(progress.positionMeters > 40 && progress.positionMeters < 60);
  assert.ok(Math.abs(progress.totalDistanceMeters - tracker.totalMeters) < 5);
  assert.ok(progress.remainingDistanceMeters < tracker.totalMeters - 40);
  assert.ok(progress.offRouteMeters < 0.5);
  assert.deepEqual(progress.snapPoint, [13.405, 52.52045]);
  assert.equal(progress.nextManeuver.stepIndex, 1); // the first turn ahead
  assert.ok(progress.nextManeuver.distanceMeters > 40);
  assert.equal(progress.followingManeuver.stepIndex, 2);
});

test('remaining duration is null unless every duration-carrying step is placeable', () => {
  const tracker = createRouteTracker(GEOMETRY);
  const schedule = buildManeuverSchedule(tracker, ROUTE);
  const fix = { lat: 52.52045, lng: 13.405, accuracy: 10 };
  const proj = tracker.project(fix.lat, fix.lng, 0);
  const progress = computeRouteProgress({ tracker, route: ROUTE, fix, proj, schedule });
  // Every duration-carrying step is placeable, so a sum exists: the depart
  // step is behind the fix, the first turn (30 s) is ahead, and the arrive
  // step carries no duration at all (the provider gave none).
  assert.equal(progress.remainingDurationSeconds, 30);

  // A step with a duration but an unplaceable location poisons the sum.
  const partial = {
    geometry: GEOMETRY,
    legs: [{ steps: [
      { name: 'A', distance: 100, duration: 30, maneuver: { type: 'depart', modifier: null, location: [13.405, 52.52] } },
      { name: 'B', distance: 100, duration: 30, maneuver: { type: 'turn', modifier: 'left', location: [13.9, 52.9] } },
    ] }],
  };
  const partialSchedule = buildManeuverSchedule(tracker, partial);
  const partialProgress = computeRouteProgress({ tracker, route: partial, fix, proj, schedule: partialSchedule });
  assert.equal(partialProgress.remainingDurationSeconds, null);
  assert.equal(partialProgress.nextManeuver, null); // unplaceable: not scheduled
});

test('remainingGeometry returns the not-yet-travelled part of the line', () => {
  const tracker = createRouteTracker(GEOMETRY);
  const proj = tracker.project(52.52045, 13.405, 0);
  const line = remainingGeometry(GEOMETRY, proj);
  assert.equal(line.length, 4); // snap point + the 3 remaining vertices
  assert.deepEqual(line[0], [13.405, 52.52045]);
  assert.deepEqual(line[line.length - 1], GEOMETRY[GEOMETRY.length - 1]);
  // The original geometry is never mutated.
  assert.deepEqual(GEOMETRY[0], [13.405, 52.52]);
  assert.equal(remainingGeometry(GEOMETRY, null), null);
});

test('isArrived is measured in metres against the destination or line end, never time', () => {
  const destination = { lat: 52.52, lon: 13.4062 };
  const geometryEnd = [13.4062, 52.52];
  // 20 m south of both: inside the 30 m radius.
  assert.equal(isArrived({ lat: 52.51982, lng: 13.4062, accuracy: 5 }, destination, geometryEnd, 30), true);
  // 200 m away: not arrived, whatever the clock says.
  assert.equal(isArrived({ lat: 52.52, lng: 13.404, accuracy: 5 }, destination, geometryEnd, 30), false);
  // Accuracy widens the radius: a 60 m-accurate fix 60 m out is "there".
  assert.equal(isArrived({ lat: 52.51965, lng: 13.4062, accuracy: 60 }, destination, geometryEnd, 30), true);
  // No usable fix: never arrived.
  assert.equal(isArrived(null, destination, geometryEnd, 30), false);
});