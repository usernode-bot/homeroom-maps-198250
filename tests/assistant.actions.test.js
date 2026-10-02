// Pure action/tool validation for the AI assistant (Phase 11). No database, no
// network, no model: this drives assistant/actions.js directly, exactly the
// acceptance criteria that "the pure cores pass with no database and no
// network" and that unknown or owner-scoped actions are rejected.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ActionError,
  ACTION_TOOLS,
  validateActionShape,
  normalizeAction,
  describeAction,
} = require('../assistant/actions');

test('the allowlist is exactly the four documented actions', () => {
  assert.deepEqual(Object.keys(ACTION_TOOLS).sort(), [
    'add_trip_item',
    'open_community',
    'save_place',
    'show_route',
  ]);
  // Writes are only the two domain-mutating ones; the other two are views.
  assert.equal(ACTION_TOOLS.save_place.write, true);
  assert.equal(ACTION_TOOLS.add_trip_item.write, true);
  assert.equal(ACTION_TOOLS.show_route.write, false);
  assert.equal(ACTION_TOOLS.open_community.write, false);
});

test('an unknown tool is rejected and never normalized', () => {
  assert.throws(() => validateActionShape({ tool: 'delete_everything', args: {} }), (err) => {
    assert.ok(err instanceof ActionError);
    assert.equal(err.code, 'unknown_tool');
    return true;
  });
});

test('a malformed action is rejected', () => {
  for (const bad of [null, 'save', 42, [], { args: {} }]) {
    assert.throws(() => validateActionShape(bad), (err) => err instanceof ActionError);
  }
});

test('save_place requires a place with an id and a name', () => {
  assert.throws(() => validateActionShape({ tool: 'save_place', args: { place: { name: 'X' } } }), (err) => {
    assert.equal(err.code, 'invalid_action');
    assert.ok(err.fields.place);
    return true;
  });
  assert.throws(() => validateActionShape({ tool: 'save_place', args: { place: { id: '1' } } }), (err) => {
    assert.ok(err.fields.place);
    return true;
  });
});

test('save_place trims and normalizes a valid place, keeps optional fields only when present', () => {
  const out = validateActionShape({
    tool: 'save_place',
    args: {
      place: { id: ' p1 ', name: ' Cafe ', category: 'restaurant', lat: 52.5, lng: 13.4, junk: 'drop' },
      listRef: 'favorites',
    },
  });
  assert.equal(out.tool, 'save_place');
  assert.deepEqual(out.args.place, { id: 'p1', name: 'Cafe', category: 'restaurant', lat: 52.5, lng: 13.4 });
  assert.equal(out.args.listRef, 'favorites');
});

test('out-of-range coordinates are dropped, not repaired', () => {
  const out = validateActionShape({
    tool: 'save_place',
    args: { place: { id: 'p1', name: 'X', lat: 999, lng: 999 } },
  });
  assert.equal('lat' in out.args.place, false);
  assert.equal('lng' in out.args.place, false);
});

test('add_trip_item requires a trip id, a day id and a place', () => {
  assert.throws(
    () => validateActionShape({ tool: 'add_trip_item', args: { tripId: 't1', place: { id: 'p', name: 'X' } } }),
    (err) => {
      assert.equal(err.code, 'invalid_action');
      assert.ok(err.fields.dayId);
      return true;
    },
  );
});

test('show_route requires a destination point and rejects a bad mode', () => {
  const ok = validateActionShape({ tool: 'show_route', args: { destination: { lat: 1, lng: 2 }, mode: 'driving' } });
  assert.equal(ok.args.mode, 'driving');
  assert.throws(() => validateActionShape({ tool: 'show_route', args: {} }), (err) => {
    assert.ok(err.fields.destination);
    return true;
  });
  assert.throws(
    () => validateActionShape({ tool: 'show_route', args: { destination: { lat: 1, lng: 2 }, mode: 'teleport' } }),
    (err) => {
      assert.ok(err.fields.mode);
      return true;
    },
  );
});

test('open_community only accepts proposals or reports and known views', () => {
  assert.equal(validateActionShape({ tool: 'open_community', args: { tab: 'reports', view: 'popular' } }).args.tab, 'reports');
  assert.throws(() => validateActionShape({ tool: 'open_community', args: { tab: 'chats' } }), (err) => {
    assert.ok(err.fields.tab);
    return true;
  });
});

test('normalizeAction returns the endpoint and marks write actions', async () => {
  const out = await normalizeAction(
    { tool: 'save_place', args: { place: { id: 'p1', name: 'X' } } },
    { viewer: { id: 'u1' } },
  );
  assert.equal(out.write, true);
  assert.equal(out.endpoint, 'POST /api/saved/places');
  assert.equal(out.summary, 'Save X');
});

test('normalizeAction rejects an action naming another person\'s trip (not_found, no leak)', async () => {
  const getTrip = async (viewer, tripId) => {
    assert.equal(viewer.id, 'u1');
    const err = new Error('That trip does not exist.');
    err.code = 'not_found';
    throw err;
  };
  await assert.rejects(
    () =>
      normalizeAction(
        { tool: 'add_trip_item', args: { tripId: '999', dayId: '1', place: { id: 'p', name: 'X' } } },
        { viewer: { id: 'u1' }, getTrip },
      ),
    (err) => {
      assert.ok(err instanceof ActionError);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('normalizeAction accepts the viewer\'s own trip when the reader resolves it', async () => {
  const getTrip = async () => ({ id: '5', name: 'Mine', days: [] });
  const out = await normalizeAction(
    { tool: 'add_trip_item', args: { tripId: '5', dayId: '1', place: { id: 'p', name: 'X' } } },
    { viewer: { id: 'u1' }, getTrip },
  );
  assert.equal(out.write, true);
  assert.match(out.endpoint, /\/api\/trips\/:tripId\/days\/:dayId\/items$/);
});

test('describeAction produces a short English summary', () => {
  assert.equal(describeAction('save_place', { place: { name: 'Cafe' }, listRef: 'travel' }), 'Save Cafe to travel');
  assert.equal(describeAction('open_community', { tab: 'reports' }), 'Open community reports');
});
