// Location sharing model (Phase 12F) — the pure rules, no database, no DOM.
//
// Covers: the duration whitelist, the fixed expiry, recipient normalization
// (dedupe, cap, self-exclusion), fix validation with coordinate minimization
// (4 dp truncation toward zero, accuracy ceiling and cap), and the id parse
// that turns malformed ids into 404s rather than 500s.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SharingError,
  DURATIONS,
  MAX_RECIPIENTS,
  parseId,
  validateDuration,
  expiresAtFor,
  normalizeRecipientHandles,
  validateFix,
} = require('../sharing/model');

function throws(fn, match) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SharingError, `expected SharingError, got ${err}`);
    assert.match(err.message, match);
    return err;
  }
  assert.fail('expected the call to throw');
}

test('duration whitelist is exactly the three fixed lengths', () => {
  assert.deepEqual(DURATIONS, [60, 480, 1440]);
  assert.equal(validateDuration(60), 60);
  assert.equal(validateDuration('480'), 480);
  assert.equal(validateDuration(1440), 1440);
  // Everything else is refused, including near-misses and coercion traps.
  for (const bad of [0, 1, 59, 61, 120, '61', true, null, undefined, {}, NaN, Infinity, -60, 1441]) {
    const err = throws(() => validateDuration(bad), /Choose how long/);
    assert.equal(err.status, 400);
    assert.ok(err.fields && err.fields.durationMinutes);
  }
});

test('the end time is fixed at creation and never derived from a stored clock', () => {
  const now = new Date('2026-10-11T09:00:00Z');
  assert.deepEqual(expiresAtFor(60, now), new Date('2026-10-11T10:00:00Z'));
  assert.deepEqual(expiresAtFor(1440, now), new Date('2026-10-12T09:00:00Z'));
});

test('recipient handles: trim, case-insensitive dedupe, strings only, cap', () => {
  assert.deepEqual(
    normalizeRecipientHandles([' Bob ', 'BOB', 'alice'], { viewerUsername: 'me' }),
    ['Bob', 'alice'],
  );
  // Non-strings are skipped, empties dropped, and a fully empty list is a
  // typed 400 — never "share with nobody".
  const err = throws(
    () => normalizeRecipientHandles(['', '   ', 42, null], { viewerUsername: 'me' }),
    /Choose who/,
  );
  assert.equal(err.status, 400);
  assert.ok(err.fields.recipients);
  assert.throws(() => normalizeRecipientHandles('bob', { viewerUsername: 'me' }), /Choose who/);
  // The caller is excluded by name, in any casing.
  throws(
    () => normalizeRecipientHandles(['alice', 'Me'], { viewerUsername: 'me' }),
    /You are already the one sharing/,
  );
  // The cap is enforced after dedupe.
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => 'user' + i);
  throws(() => normalizeRecipientHandles(many, { viewerUsername: 'me' }), /at most/);
  assert.equal(normalizeRecipientHandles(many.slice(0, MAX_RECIPIENTS), { viewerUsername: 'me' }).length, MAX_RECIPIENTS);
});

test('parseId: digits only, 404 for anything else (never a 500 or a guess)', () => {
  assert.equal(parseId('123'), '123');
  assert.equal(parseId(123), '123');
  for (const bad of ['abc', '', '0x10', '12.5', '-1', '../9', '1;DROP', '999999999999999999999']) {
    const err = throws(() => parseId(bad), /does not exist/);
    assert.equal(err.status, 404);
  }
});

test('fix validation minimizes precision BEFORE anything could be stored', () => {
  // 4 dp toward zero, on both axes, positive and negative.
  assert.deepEqual(validateFix({ lat: 52.123456789, lng: 13.987654321 }), {
    lat: 52.1234,
    lng: 13.9876,
    accuracy: null,
  });
  assert.deepEqual(validateFix({ lat: -52.123456789, lng: -13.987654321 }), {
    lat: -52.1234,
    lng: -13.9876,
    accuracy: null,
  });
  // Accuracy is ceiled (never understated) and capped at 100000 m.
  assert.equal(validateFix({ lat: 0, lng: 0, accuracy: 12.2 }).accuracy, 13);
  assert.equal(validateFix({ lat: 0, lng: 0, accuracy: '8' }).accuracy, 8);
  assert.equal(validateFix({ lat: 0, lng: 0, accuracy: 999999 }).accuracy, 100000);
  assert.equal(validateFix({ lat: 0, lng: 0, accuracy: 0 }).accuracy, 0);
});

test('fix validation refuses unusable coordinates with typed 400s', () => {
  for (const bad of [
    { lat: 95, lng: 0 },
    { lat: 0, lng: 190 },
    { lat: 'north', lng: 0 },
    { lat: NaN, lng: 0 },
    { lat: Infinity, lng: 0 },
    {},
    null,
    'nope',
    { lat: 0, lng: 0, accuracy: -1 },
    { lat: 0, lng: 0, accuracy: 'far' },
  ]) {
    const err = throws(() => validateFix(bad), /not a valid location|that position/i);
    assert.equal(err.status, 400);
    assert.ok(err.fields);
  }
  // Boundaries themselves are valid.
  assert.deepEqual(validateFix({ lat: 90, lng: 180 }).lat, 90);
  assert.deepEqual(validateFix({ lat: -90, lng: -180 }).lng, -180);
});
