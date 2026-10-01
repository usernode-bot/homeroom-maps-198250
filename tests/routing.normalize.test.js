// Unit tests for the routing normalization layer (routing/normalize.js):
// request validation (origin/destination/waypoints/mode), the normalized
// RouteResult shape, and the road-name derivation. All synchronous, no I/O.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRAVEL_MODES,
  MAX_WAYPOINTS,
  parseLatLng,
  parseWaypoints,
  normalizeMode,
  validateRouteRequest,
  normalizeRoute,
  roadNamesOf,
} = require('../routing/normalize');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null; // did not throw
}

test('travel modes and the waypoint cap are the shared contract', () => {
  assert.deepEqual(TRAVEL_MODES, ['driving', 'walking', 'cycling', 'motorcycle', 'transit']);
  assert.equal(MAX_WAYPOINTS, 5);
});

test('parseLatLng accepts a valid pair', () => {
  assert.deepEqual(parseLatLng('52.52,13.405', 'Origin'), { lat: 52.52, lon: 13.405 });
});

test('parseLatLng refuses missing, malformed and out-of-range pairs with invalid_request', () => {
  assert.equal(codeOf(() => parseLatLng('', 'Origin')), 'invalid_request');
  assert.equal(codeOf(() => parseLatLng(null, 'Origin')), 'invalid_request');
  assert.equal(codeOf(() => parseLatLng('52.5', 'Origin')), 'invalid_request');
  assert.equal(codeOf(() => parseLatLng('a,b', 'Origin')), 'invalid_request');
  assert.equal(codeOf(() => parseLatLng('52.52,13.405,9', 'Origin')), 'invalid_request');
  assert.equal(codeOf(() => parseLatLng('95,13', 'Origin')), 'invalid_request'); // lat out of range
  assert.equal(codeOf(() => parseLatLng('52,-190', 'Origin')), 'invalid_request'); // lon out of range
});

test('parseWaypoints splits on the pipe and parses each pair', () => {
  assert.deepEqual(parseWaypoints('1,2|3,4'), [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  assert.deepEqual(parseWaypoints(''), []);
  assert.deepEqual(parseWaypoints(null), []);
});

test('parseWaypoints refuses over-cap and malformed lists', () => {
  const six = Array.from({ length: 6 }, (_, i) => `${i},${i}`).join('|');
  assert.equal(codeOf(() => parseWaypoints(six)), 'invalid_request');
  assert.equal(codeOf(() => parseWaypoints('1,2|oops')), 'invalid_request');
});

test('normalizeMode defaults to driving and refuses unknown modes', () => {
  assert.equal(normalizeMode(), 'driving');
  assert.equal(normalizeMode(''), 'driving');
  assert.equal(normalizeMode('DRIVING'), 'driving');
  assert.equal(normalizeMode('walking'), 'walking');
  assert.equal(codeOf(() => normalizeMode('teleport')), 'invalid_request');
});

test('validateRouteRequest shapes the normalized request', () => {
  const request = validateRouteRequest({
    origin: '52.52,13.405',
    destination: '48.13,11.58',
    waypoints: '50,8',
    mode: 'driving',
  });
  assert.deepEqual(request, {
    origin: { lat: 52.52, lon: 13.405 },
    destination: { lat: 48.13, lon: 11.58 },
    waypoints: [{ lat: 50, lon: 8 }],
    mode: 'driving',
  });
  assert.deepEqual(validateRouteRequest({ origin: '1,2', destination: '3,4' }), {
    origin: { lat: 1, lon: 2 },
    destination: { lat: 3, lon: 4 },
    waypoints: [],
    mode: 'driving',
  });
});

test('normalizeRoute returns null for anything without usable geometry', () => {
  assert.equal(normalizeRoute(null, 'osrm'), null);
  assert.equal(normalizeRoute({}, 'osrm'), null);
  assert.equal(normalizeRoute({ geometry: [] }, 'osrm'), null);
  assert.deepEqual(
    normalizeRoute({ geometry: [[1], [2, 3], ['x', 4], [5, 6]] }, 'osrm').geometry,
    [[2, 3], [5, 6]], // only finite [lng, lat] pairs survive
  );
});

test('normalizeRoute fills every field: absent optionals stay null/empty', () => {
  const route = normalizeRoute(
    {
      geometry: [[13.4, 52.5], [13.5, 52.6]],
      distance: 12345,
      duration: 900,
      summary: 'A 100',
      restrictions: ['No left turn', ''],
      roadInformation: ['A 100', ' A 100 ', 42],
    },
    'osrm',
  );
  assert.equal(route.geometry.length, 2);
  assert.equal(route.distance, 12345);
  assert.equal(route.duration, 900);
  assert.equal(route.summary, 'A 100');
  assert.deepEqual(route.restrictions, ['No left turn']); // non-strings and blanks dropped
  assert.deepEqual(route.roadInformation, ['A 100', 'A 100']);
  assert.equal(route.provider, 'osrm');
  assert.deepEqual(route.legs, []);
});

test('normalizeRoute keeps null distance/duration rather than a made-up number', () => {
  const route = normalizeRoute({ geometry: [[1, 2]], distance: 'many', duration: -5 }, 'stub');
  assert.equal(route.distance, null);
  assert.equal(route.duration, null);
  assert.equal(route.provider, 'stub');
});

test('normalizeRoute normalizes legs, steps and maneuvers', () => {
  const route = normalizeRoute(
    {
      geometry: [[1, 2]],
      legs: [
        {
          distance: 100,
          duration: 60,
          steps: [
            {
              name: 'Kurfürstendamm',
              ref: 'B 2',
              distance: 60,
              duration: 40,
              maneuver: { type: 'depart', modifier: null, location: [1, 2] },
            },
            { name: '', distance: 40, duration: 20, maneuver: { type: 'turn', modifier: 'left' } },
            'garbage',
          ],
        },
        'also garbage',
      ],
    },
    'osrm',
  );
  assert.equal(route.legs.length, 1);
  assert.equal(route.legs[0].steps.length, 2);
  assert.deepEqual(route.legs[0].steps[0], {
    name: 'Kurfürstendamm',
    ref: 'B 2',
    distance: 60,
    duration: 40,
    maneuver: { type: 'depart', modifier: null, location: [1, 2] },
  });
  // A step with no name/ref keeps them null; a maneuver with no location too.
  assert.equal(route.legs[0].steps[1].name, null);
  assert.equal(route.legs[0].steps[1].maneuver.location, null);
});

test('roadNamesOf collapses consecutive repeats and keeps order', () => {
  const legs = normalizeRoute(
    {
      geometry: [[1, 2]],
      legs: [
        {
          steps: [
            { name: 'A 100' },
            { name: 'A 100' },
            { ref: 'B 2' },
            { name: 'B 2' }, // same text via name right after ref: collapsed
            { name: 'C 9' },
          ],
        },
      ],
    },
    'stub',
  );
  assert.deepEqual(roadNamesOf(legs.legs), ['A 100', 'B 2', 'C 9']);
});

test('roadNamesOf yields nothing when no step carried a name', () => {
  const legs = normalizeRoute({ geometry: [[1, 2]], legs: [{ steps: [{ name: null }] }] }, 'stub');
  assert.deepEqual(roadNamesOf(legs.legs), []);
});
