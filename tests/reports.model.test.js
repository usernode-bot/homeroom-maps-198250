// Pure rules of the reports model (reports/model.js): the eleven types and
// their expiration windows, the reviewer-only lifecycle, who may react or
// flag, validation, and feed query parsing.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../reports/model');

const reporter = { id: '1', username: 'alice', reviewer: false };
const other = { id: '2', username: 'bob', reviewer: false };
const reviewer = { id: '3', username: 'rita', reviewer: true };
const rep = (status, over = {}) => ({ reporterId: '1', status, expiresAt: new Date('2030-01-01T00:00:00Z'), ...over });

test('every type and status from the spec exists, in order', () => {
  assert.deepEqual(
    m.TYPES.map((t) => t.id),
    [
      'traffic',
      'accident',
      'road_closed',
      'construction',
      'hazard',
      'flood',
      'fire',
      'broken_road',
      'wrong_map_data',
      'place_closed',
      'other',
    ],
  );
  assert.deepEqual(m.STATUSES.map((s) => s.label), ['Pending', 'Verified', 'Rejected']);
  assert.ok(!m.STATUSES.some((s) => s.id === 'expired'), 'expired is derived, never stored');
});

test('each type carries its own expiration window', () => {
  const hours = Object.fromEntries(m.TYPES.map((t) => [t.id, t.expiresHours]));
  assert.equal(hours.traffic, 3);
  assert.equal(hours.accident, 6);
  assert.equal(hours.hazard, 12);
  assert.equal(hours.fire, 12);
  assert.equal(hours.flood, 24);
  assert.equal(hours.road_closed, 24 * 7);
  assert.equal(hours.broken_road, 24 * 30);
  assert.equal(hours.construction, 24 * 30);
  assert.equal(hours.wrong_map_data, 24 * 90);
  assert.equal(hours.place_closed, 24 * 90);
  assert.equal(hours.other, 24 * 14);
});

test('expiresAtFor derives the instant from the type window', () => {
  const from = new Date('2026-10-01T12:00:00Z');
  assert.equal(m.expiresAtFor('traffic', from), '2026-10-01T15:00:00.000Z');
  assert.equal(m.expiresAtFor('road_closed', from), '2026-10-08T12:00:00.000Z');
  assert.throws(() => m.expiresAtFor('bogus', from));
});

test('transitions: only listed moves, reviewers only, rejected is terminal', () => {
  assert.doesNotThrow(() => m.assertTransition(reviewer, rep('pending'), 'verified'));
  assert.doesNotThrow(() => m.assertTransition(reviewer, rep('pending'), 'rejected'));
  assert.doesNotThrow(() => m.assertTransition(reviewer, rep('verified'), 'rejected'));
  assert.throws(() => m.assertTransition(reporter, rep('pending'), 'verified'), { code: 'forbidden' });
  assert.throws(() => m.assertTransition(other, rep('pending'), 'verified'), { code: 'forbidden' });
  assert.throws(() => m.assertTransition(reviewer, rep('pending'), 'pending'), { code: 'invalid_transition' });
  assert.throws(() => m.assertTransition(reviewer, rep('pending'), 'bogus'), { code: 'invalid_status' });
  assert.throws(() => m.assertTransition(reviewer, rep('verified'), 'pending'), { code: 'invalid_transition' });
  for (const to of ['pending', 'verified', 'rejected']) {
    assert.throws(() => m.assertTransition(reviewer, rep('rejected'), to), { code: 'invalid_transition' }, to);
  }
  assert.deepEqual(m.allowedTransitions(reviewer, rep('pending')), ['verified', 'rejected']);
  assert.deepEqual(m.allowedTransitions(reviewer, rep('verified')), ['rejected']);
  assert.deepEqual(m.allowedTransitions(other, rep('pending')), []);
});

test('reactions and flags: anyone except the reporter', () => {
  const pending = rep('pending');
  assert.equal(m.canReact(reporter, pending), false);
  assert.equal(m.canReact(other, pending), true);
  assert.equal(m.canReact(reviewer, pending), true);
  assert.equal(m.canFlag(reporter, pending), false);
  assert.equal(m.canFlag(other, pending), true);
  assert.match(m.reactBlockReason(reporter, pending), /own report/);
  assert.match(m.flagBlockReason(reporter, pending), /own report/);
  // The lifecycle does not close reactions: the rules only exclude the
  // reporter, whatever the stored status is.
  assert.equal(m.canReact(other, rep('rejected')), true);
  assert.equal(m.canReact(other, rep('pending', { expiresAt: new Date('2000-01-01T00:00:00Z') })), true);
});

test('expiration is derived: past expires_at reads expired unless rejected', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const stale = { reporterId: '1', expiresAt: new Date('2026-10-01T11:00:00Z') };
  assert.equal(m.effectiveStatus({ ...stale, status: 'pending' }, now), 'expired');
  assert.equal(m.effectiveStatus({ ...stale, status: 'verified' }, now), 'expired');
  assert.equal(m.effectiveStatus({ ...stale, status: 'rejected' }, now), 'rejected');
  const fresh = { reporterId: '1', status: 'pending', expiresAt: new Date('2026-10-01T13:00:00Z') };
  assert.equal(m.effectiveStatus(fresh, now), 'pending');
});

test('validateReport cleans input and rejects bad types and coordinates', () => {
  const ok = m.validateReport({
    type: ' flood ',
    lat: '52.5',
    lng: -13.4,
    description: '  Water   over   the  road.\n\n\nStay clear. ',
  });
  assert.equal(ok.type, 'flood');
  assert.equal(ok.lat, 52.5);
  assert.equal(ok.lng, -13.4);
  assert.equal(ok.description, 'Water   over   the  road.\n\nStay clear.');
  assert.equal(ok.placeId, null);
  assert.equal(ok.placeProvider, null);

  assert.throws(() => m.validateReport({ type: 'nope', lat: 1, lng: 2 }), (err) => {
    assert.equal(err.code, 'invalid_report_type');
    assert.ok(err.fields.type);
    return true;
  });
  assert.throws(() => m.validateReport({ type: 'fire', lat: 100, lng: 2 }), (err) => {
    assert.equal(err.code, 'invalid_coordinates');
    assert.ok(err.fields.location);
    return true;
  });
  assert.throws(() => m.validateReport({ type: 'fire', lat: 1, lng: 181 }), (err) => err.code === 'invalid_coordinates');
  assert.throws(() => m.validateReport({ type: 'fire', lat: 'x', lng: 'y' }), (err) => err.code === 'invalid_coordinates');
  assert.throws(
    () => m.validateReport({ type: 'fire', lat: 1, lng: 2, description: 'x'.repeat(2001) }),
    (err) => Boolean(err.fields.description),
  );
  assert.throws(
    () => m.validateReport({ type: 'fire', lat: 1, lng: 2, placeId: 'only-id' }),
    (err) => Boolean(err.fields.placeId),
  );
  const place = m.validateReport({
    type: 'place_closed',
    lat: 1,
    lng: 2,
    placeId: ' p-1 ',
    placeProvider: ' photon ',
  });
  assert.deepEqual(place.placeId, 'p-1');
  assert.deepEqual(place.placeProvider, 'photon');
});

test('feed query parsing', () => {
  assert.deepEqual(m.parseFeedQuery({}), {
    view: 'recent',
    limit: 20,
    offset: 0,
    near: null,
    radiusKm: 25,
    type: null,
    placeId: null,
    includeExpired: false,
  });
  assert.equal(m.parseFeedQuery({ view: 'nope' }).view, 'recent');
  assert.equal(m.parseFeedQuery({ limit: '500' }).limit, 50);
  assert.deepEqual(m.parseFeedQuery({ view: 'nearby', near: '1.5,2.5', radius: '999' }).near, { lat: 1.5, lng: 2.5 });
  assert.equal(m.parseFeedQuery({ view: 'nearby', near: '1.5,2.5', radius: '999' }).radiusKm, 200);
  assert.equal(m.parseFeedQuery({ includeExpired: '1' }).includeExpired, true);
  assert.equal(m.parseFeedQuery({ type: 'fire' }).type, 'fire');
  assert.throws(() => m.parseFeedQuery({ view: 'nearby' }), { code: 'invalid_query' });
  assert.throws(() => m.parseFeedQuery({ view: 'nearby', near: '100,0' }), { code: 'invalid_query' });
  assert.throws(() => m.parseFeedQuery({ type: 'bogus' }), { code: 'invalid_report_type' });
  assert.throws(() => m.parseFeedQuery({ placeId: 'x'.repeat(201) }), { code: 'invalid_query' });
});

test('reactions and flag reasons are parsed strictly', () => {
  assert.equal(m.parseReactionValue('Confirm'), 'confirm');
  assert.equal(m.parseReactionValue('disagree'), 'disagree');
  assert.throws(() => m.parseReactionValue('maybe'), { code: 'invalid_reaction' });
  assert.throws(() => m.parseReactionValue(0), { code: 'invalid_reaction' });
  assert.equal(m.parseFlagReason('  looks like spam  '), 'looks like spam');
  assert.equal(m.parseFlagReason(''), null);
  assert.equal(m.parseFlagReason(undefined), null);
  assert.throws(
    () => m.parseFlagReason('x'.repeat(501)),
    (err) => Boolean(err.fields.reason),
  );
});