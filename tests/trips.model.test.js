// Pure rules of the trip model (trips/model.js) and the client-side core
// (public/js/services/trips-core.js): date expansion and validation, item
// validation, reorder math, leg pairing and error mapping. No database, no
// DOM — the browser ESM helpers load through a dynamic import, the same
// convention the other client tests use.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../trips/model');

let core = null;
async function loadCore() {
  if (!core) core = await import('../public/js/services/trips-core.js');
  return core;
}
function coreTest(name, fn) {
  return test(name, async (t) => {
    await loadCore();
    return fn(t);
  });
}

// ── server model ─────────────────────────────────────────────────────────

test('expandDays is inclusive, leap-year correct and month-spanning', () => {
  assert.deepEqual(model.expandDays('2024-02-27', '2024-03-02'), [
    '2024-02-27',
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
    '2024-03-02',
  ]);
  assert.deepEqual(model.expandDays('2025-02-27', '2025-03-01'), [
    '2025-02-27',
    '2025-02-28',
    '2025-03-01',
  ]);
  assert.deepEqual(model.expandDays('2026-12-30', '2027-01-02'), [
    '2026-12-30',
    '2026-12-31',
    '2027-01-01',
    '2027-01-02',
  ]);
  assert.deepEqual(model.expandDays('2026-06-13', '2026-06-13'), ['2026-06-13']);
});

test('expandDays rejects malformed and inverted ranges', () => {
  assert.deepEqual(model.expandDays('2026-02-30', '2026-03-01'), []);
  assert.deepEqual(model.expandDays('nope', '2026-03-01'), []);
  assert.deepEqual(model.expandDays('2026-03-02', '2026-03-01'), []);
});

test('validateTrip reports each field and enforces the day cap', () => {
  assert.throws(() => model.validateTrip({ name: '' }), (err) => {
    assert.equal(err.code, 'invalid_trip');
    assert.ok(err.fields.name);
    assert.ok(err.fields.dates);
    return true;
  });
  assert.throws(
    () => model.validateTrip({ name: 'x'.repeat(121), startDate: '2026-01-01', endDate: '2026-01-02' }),
    (err) => Boolean(err.fields.name),
  );
  assert.throws(
    () => model.validateTrip({ name: 'Trip', startDate: '2026-01-05', endDate: '2026-01-01' }),
    (err) => Boolean(err.fields.dates),
  );
  assert.throws(
    () => model.validateTrip({ name: 'Trip', startDate: '2026-01-01', endDate: '2026-04-01' }),
    (err) => Boolean(err.fields.dates),
  );
  const ok = model.validateTrip({
    name: '  Jakarta   Weekend ',
    destination: { name: 'Jakarta', lat: -6.2, lng: 106.8 },
    startDate: '2026-06-13',
    endDate: '2026-06-14',
  });
  assert.equal(ok.name, 'Jakarta Weekend');
  assert.deepEqual(ok.destination, { name: 'Jakarta', lat: -6.2, lng: 106.8 });
});

test('destination coordinates are optional but must be in range', () => {
  assert.equal(model.validateTrip({ name: 'A', startDate: '2026-01-01', endDate: '2026-01-01' }).destination, null);
  assert.throws(
    () => model.validateTrip({
      name: 'A',
      destination: { name: 'Nowhere', lat: 999, lng: 0 },
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }),
    (err) => Boolean(err.fields.destination),
  );
});

test('validateItem requires a place and validates time/duration/notes', () => {
  assert.throws(() => model.validateItem({ placeId: '' }), (err) => Boolean(err.fields.placeId));
  assert.throws(() => model.validateItem({ placeId: 'p1', startTime: '25:00' }), (err) => Boolean(err.fields.startTime));
  assert.throws(
    () => model.validateItem({ placeId: 'p1', durationMinutes: 0 }),
    (err) => Boolean(err.fields.durationMinutes),
  );
  assert.throws(
    () => model.validateItem({ placeId: 'p1', notes: 'x'.repeat(2001) }),
    (err) => Boolean(err.fields.notes),
  );
  const ok = model.validateItem({
    placeId: 'node/123',
    placeSnapshot: { name: 'Museum', coordinates: { lat: -6.17, lng: 106.82 } },
    startTime: '09:30',
    durationMinutes: 120,
    notes: 'Bring water',
  });
  assert.equal(ok.placeId, 'node/123');
  assert.equal(ok.startTime, '09:30');
  assert.equal(ok.durationMinutes, 120);
  assert.equal(ok.placeSnapshot.name, 'Museum');
});

test('a partial item edit validates only the keys it carries', () => {
  const onlyNotes = model.validateItem({ notes: 'later' }, { partial: true });
  assert.deepEqual(onlyNotes, { notes: 'later' });
  assert.throws(() => model.validateItem({ durationMinutes: -1 }, { partial: true }));
  // An empty body is a legal no-op edit.
  assert.deepEqual(model.validateItem({}, { partial: true }), {});
});

test('parse ids: non-numeric is a not_found, not a crash', () => {
  assert.equal(model.parseTripId('42'), '42');
  for (const bad of ['abc', '', '0', '1.5', '-3', null]) {
    assert.throws(() => model.parseTripId(bad), { code: 'not_found', status: 404 });
  }
});

// ── client core ──────────────────────────────────────────────────────────

coreTest('core dayRange matches the server expansion and is leap-year correct', () => {
  assert.deepEqual(core.dayRange('2024-02-27', '2024-03-02'), model.expandDays('2024-02-27', '2024-03-02'));
  assert.deepEqual(core.dayRange('2026-03-02', '2026-03-01'), []);
});

coreTest('moveWithin and moveBetween keep the order and clamp the target', () => {
  const items = ['a', 'b', 'c', 'd'];
  assert.deepEqual(core.moveWithin(items, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(core.moveWithin(items, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(core.moveWithin(items, 1, 99), ['a', 'c', 'd', 'b']);
  assert.deepEqual(core.moveWithin(items, 9, 0), items);
  // The input array is never mutated.
  assert.deepEqual(items, ['a', 'b', 'c', 'd']);

  const moved = core.moveBetween(['a', 'b'], ['c'], 0, 5);
  assert.deepEqual(moved.fromList, ['b']);
  assert.deepEqual(moved.toList, ['c', 'a']);
  assert.deepEqual(core.moveBetween(['a'], ['b'], 4, 0).fromList, ['a']);
});

coreTest('legPairs pairs only consecutive stops that both carry coordinates', () => {
  const withCoords = (id, lat, lng) => ({ id, place: { coordinates: { lat, lng } } });
  const noCoords = (id) => ({ id, place: { coordinates: null } });
  const items = [withCoords('1', 1, 1), withCoords('2', 2, 2), noCoords('3'), withCoords('4', 4, 4)];
  const pairs = core.legPairs(items);
  // 1->2 is routable; 2->3 and 3->4 both involve a stop with no coordinates.
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].from.id, '1');
  assert.equal(pairs[0].to.id, '2');
  assert.deepEqual(pairs[0].origin, { lat: 1, lng: 1 });
  assert.deepEqual(core.legRequest(pairs[0], 'driving'), {
    origin: { lat: 1, lon: 1 },
    destination: { lat: 2, lon: 2 },
    mode: 'driving',
  });
});

coreTest('selectableModes offers only what the provider serves', async () => {
  const config = { routing: { configured: true, modes: ['driving', 'bogus'] } };
  assert.deepEqual(core.selectableModes(config), ['driving']);
  assert.ok(core.unavailableModes(config).includes('walking'));
  assert.deepEqual(core.selectableModes({ routing: { configured: false, modes: ['driving'] } }), []);
  assert.deepEqual(core.selectableModes(null), []);
});

coreTest('legErrorKind maps provider codes onto the existing route copy', () => {
  assert.equal(core.legErrorKind({ code: 'no_route' }), 'no_route');
  assert.equal(core.legErrorKind({ code: 'rate_limited' }), 'rate_limited');
  assert.equal(core.legErrorKind({ code: 'network_error' }), 'network');
  assert.equal(core.legErrorKind({ code: 'something_else' }), 'provider');
  assert.equal(core.legErrorKind(null), 'provider');
});

coreTest('legLine formats both halves and never invents a missing one', () => {
  const line = core.legLine(1200, 300, { locale: 'en', units: 'metric' });
  assert.match(line, /km/);
  assert.match(line, /min/);
  const missing = core.legLine(null, null, {
    locale: 'en',
    labels: { distance: 'Distance unavailable', duration: 'Duration unavailable' },
  });
  assert.equal(missing, 'Distance unavailable · Duration unavailable');
});

coreTest('destinationBody keeps only a picked result name and its own coordinates', async () => {
  // Nothing chosen -> the destination stays optional (null), never a stub.
  assert.equal(core.destinationBody(null), null);
  assert.equal(core.destinationBody({}), null);
  assert.equal(core.destinationBody({ name: '' }), null);
  // A picked search result -> name plus the coordinates that result carried.
  assert.deepEqual(
    core.destinationBody({ name: 'Jakarta', coordinates: { lat: -6.2, lon: 106.8 } }),
    { name: 'Jakarta', lat: -6.2, lng: 106.8 },
  );
  // A picked result with no coordinates -> name only; nothing is invented.
  assert.deepEqual(core.destinationBody({ name: 'Nowhere' }), { name: 'Nowhere' });
});
