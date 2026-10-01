// Tests for the maneuver mapping (public/js/services/navigation/maneuvers.js).
// The module imports the real i18n singleton (English is the permanent
// fallback in Node, no init needed), so the assertions check the strings
// users actually read.
//
// The honesty contract: an instruction is composed only from the fields the
// provider supplied — no road name is appended when the step carried none, an
// unknown maneuver type renders as the provider's own word, and a step with
// no maneuver type has no instruction at all.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let describeManeuver;
let maneuverInstruction;

before(async () => {
  const mod = await import('../public/js/services/navigation/maneuvers.js');
  ({ describeManeuver, maneuverInstruction } = mod);
});

const step = (maneuver, extra = {}) => ({ name: null, ref: null, maneuver, ...extra });

test('turn family maps modifiers to icons and instructions', () => {
  const left = describeManeuver(step({ type: 'turn', modifier: 'left' }));
  assert.equal(left.icon, 'turn-left');
  assert.equal(maneuverInstruction(step({ type: 'turn', modifier: 'left' })), 'Turn left');

  const sharpRight = describeManeuver(step({ type: 'turn', modifier: 'sharp right' }));
  assert.equal(sharpRight.icon, 'sharp-right');
  assert.equal(maneuverInstruction(step({ type: 'turn', modifier: 'sharp right' })), 'Turn sharp right');

  const uturn = describeManeuver(step({ type: 'turn', modifier: 'uturn' }));
  assert.equal(uturn.icon, 'uturn');
  assert.equal(maneuverInstruction(step({ type: 'turn', modifier: 'uturn' })), 'Make a U-turn');

  const endOfRoad = maneuverInstruction(step({ type: 'end of road', modifier: 'right' }));
  assert.equal(endOfRoad, 'Turn right');
});

test('a road name is appended only for the road-carrying types that carry one', () => {
  // A turn onto a named road says so.
  const onto = maneuverInstruction(step({ type: 'turn', modifier: 'left' }, { name: 'Bahnhofstraße' }));
  assert.equal(onto, 'Turn left onto Bahnhofstraße');

  // A plain turn with no road name says nothing about a road.
  assert.equal(maneuverInstruction(step({ type: 'turn', modifier: 'left' })), 'Turn left');

  // A U-turn never takes the road suffix (the type is road-carrying, but a
  // U-turn is not onto the road it names).
  const uturn = maneuverInstruction(step({ type: 'turn', modifier: 'uturn' }, { name: 'Ring Road' }));
  assert.equal(uturn, 'Make a U-turn');

  // Roundabouts do not take the suffix either.
  const roundabout = maneuverInstruction(
    step({ type: 'roundabout', modifier: null }, { name: 'Plaza' }),
  );
  assert.equal(roundabout, 'Enter the roundabout');
});

test('depart and arrive map to their own copy and icons', () => {
  const depart = describeManeuver(step({ type: 'depart', modifier: null }, { name: 'Main Street' }));
  assert.equal(depart.icon, 'straight');
  assert.equal(maneuverInstruction(step({ type: 'depart', modifier: null }, { name: 'Main Street' })), 'Start on Main Street');
  assert.equal(maneuverInstruction(step({ type: 'depart', modifier: null })), 'Start');
  assert.equal(maneuverInstruction(step({ type: 'arrive', modifier: null })), 'Arrive at your destination');
  assert.equal(describeManeuver(step({ type: 'arrive', modifier: null })).icon, 'pin');
});

test('merge, ramp, fork and roundabout cover their sides', () => {
  assert.equal(maneuverInstruction(step({ type: 'merge', modifier: 'left' })), 'Merge left');
  assert.equal(maneuverInstruction(step({ type: 'merge', modifier: null })), 'Merge');
  assert.equal(maneuverInstruction(step({ type: 'on ramp', modifier: 'right' })), 'Take the ramp on the right');
  assert.equal(maneuverInstruction(step({ type: 'off ramp', modifier: 'left' })), 'Take the exit on the left');
  assert.equal(maneuverInstruction(step({ type: 'off ramp', modifier: null })), 'Take the exit');
  assert.equal(maneuverInstruction(step({ type: 'fork', modifier: 'slight left' })), 'Keep left at the fork');
  assert.equal(maneuverInstruction(step({ type: 'fork', modifier: null })), 'Keep straight at the fork');
  // Roundabout exit number only when the provider supplied one.
  assert.equal(
    maneuverInstruction(step({ type: 'roundabout', modifier: null }, { exit: 3 })),
    'At the roundabout, take exit 3',
  );
  assert.equal(
    maneuverInstruction(step({ type: 'rotary', modifier: null })),
    'Enter the roundabout',
  );
  assert.equal(maneuverInstruction(step({ type: 'exit roundabout', modifier: null })), 'Exit the roundabout');
});

test('new name and continue keep the road the provider named', () => {
  assert.equal(
    maneuverInstruction(step({ type: 'new name', modifier: null }, { name: 'Long Avenue' })),
    'Continue on Long Avenue',
  );
  assert.equal(maneuverInstruction(step({ type: 'new name', modifier: null })), 'Continue');
  assert.equal(maneuverInstruction(step({ type: 'continue', modifier: 'straight' })), 'Continue straight');
});

test('honesty: unknown types render the provider word; missing types render nothing', () => {
  // A type this mapping does not know: the provider's own word, generic icon.
  const unknown = describeManeuver(step({ type: 'ferry', modifier: null }));
  assert.equal(unknown.icon, 'straight');
  assert.equal(unknown.key, null);
  assert.equal(maneuverInstruction(step({ type: 'ferry', modifier: null })), 'ferry');

  // No maneuver data at all: no instruction exists to show.
  const none = describeManeuver(step({ type: null, modifier: null }));
  assert.equal(none.key, null);
  assert.equal(none.text, null);
  assert.equal(maneuverInstruction(step({ type: null, modifier: null })), null);
  assert.equal(maneuverInstruction({}), null);
  assert.equal(maneuverInstruction(null), null);
});

test('ref falls back as the road name when the step carried only a ref', () => {
  const onto = maneuverInstruction(
    step({ type: 'turn', modifier: 'right' }, { name: null, ref: 'A 100' }),
  );
  assert.equal(onto, 'Turn right onto A 100');
});