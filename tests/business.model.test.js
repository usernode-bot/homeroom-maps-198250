// Business model — pure rules, no database (Phase 12J).
//
// Everything the spec gates on WITHOUT Postgres lives in business/model.js:
// who may claim, who may decide, what a claim body may carry, and the
// reviewer-configuration parsing. The Postgres suite
// (tests/business.postgres.test.js) proves the store enforces the same rules
// against real rows; this file proves the rules themselves, so a logic slip
// here fails fast without a database.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../business/model');

const OWNER = { id: '1', username: 'owner', reviewer: false };
const SOMEONE = { id: '2', username: 'someone', reviewer: false };
const REVIEWER = { id: '9', username: 'rita', reviewer: true };
const NOBODY = null;

const openCtx = {
  profile: null,
  activeClaim: null,
  myPending: false,
  myPendingCount: 0,
  lastRejectionAt: null,
  now: new Date('2026-10-12T12:00:00Z'),
};

function claim(status, extra = {}) {
  return { id: '5', status, claimantUserId: '1', ...extra };
}

const evidenceItem = () => ({
  url: `https://platform.test/app-files/${'a'.repeat(32)}`,
  contentType: 'image/png',
  filename: 'licence.png',
});

// ── lifecycle: verification is a reviewer decision, nothing else ─────────

test('only a reviewer can move a claim to verified', () => {
  assert.equal(model.canDecide(OWNER, claim('pending'), 'verified'), false);
  assert.equal(model.canDecide(SOMEONE, claim('pending'), 'verified'), false);
  assert.equal(model.canDecide(NOBODY, claim('pending'), 'verified'), false);
  assert.equal(model.canDecide(REVIEWER, claim('pending'), 'verified'), true);
});

test('assertDecision throws the typed errors the routes answer', () => {
  assert.throws(
    () => model.assertDecision(SOMEONE, claim('pending'), 'verified'),
    (err) => err.code === 'forbidden' && err.status === 403,
  );
  assert.throws(
    () => model.assertDecision(REVIEWER, claim('pending'), 'made_up'),
    (err) => err.code === 'invalid_decision',
  );
  // A decision is verified or rejected: withdrawing is the claimant's move,
  // so a reviewer's attempt is refused as forbidden, not malformed.
  assert.throws(
    () => model.assertDecision(REVIEWER, claim('pending'), 'withdrawn'),
    (err) => err.code === 'forbidden',
  );
  // Legitimate path: no throw.
  assert.doesNotThrow(() => model.assertDecision(REVIEWER, claim('pending'), 'rejected'));
});

test('the transition table keeps verification and expiry apart', () => {
  // A reviewer may verify or reject a pending claim; only the claimant may
  // withdraw it; nobody may verify something already verified.
  assert.deepEqual(model.TRANSITIONS.pending, {
    verified: 'reviewer',
    rejected: 'reviewer',
    withdrawn: 'claimant',
  });
  assert.deepEqual(model.TRANSITIONS.verified, {});
  assert.deepEqual(model.TRANSITIONS.rejected, {});
  // A superseded claim can be verified (after the winner is gone) — and
  // nothing else.
  assert.deepEqual(model.TRANSITIONS.superseded, { verified: 'reviewer' });
  // The store is the only mover of expiry, and expiry is withdrawn, never
  // verified — there is no rule here that lets anything else reach verified.
  for (const [from, moves] of Object.entries(model.TRANSITIONS)) {
    if (moves.verified) assert.equal(moves.verified, 'reviewer', from);
  }
});

test('a superseded claim verifies only once the winning claim is gone', () => {
  assert.equal(
    model.canDecide(REVIEWER, claim('superseded'), 'verified', { placeHasActiveClaim: true }),
    false,
  );
  assert.equal(
    model.canDecide(REVIEWER, claim('superseded'), 'verified', { placeHasActiveClaim: false }),
    true,
  );
  // A superseded claim is the record of a losing attempt: it is verified
  // (taking over) or left as the record it is — it is not re-decided.
  assert.equal(model.canDecide(REVIEWER, claim('superseded'), 'rejected'), false);
});

// ── claiming ─────────────────────────────────────────────────────────────

test('a place with a verified profile is never claimable', () => {
  assert.equal(model.canClaim(OWNER, { ...openCtx, profile: { id: '9', status: 'active' } }), false);
  assert.equal(
    model.claimBlockReason(OWNER, { ...openCtx, profile: { id: '9', status: 'active' } }),
    'This place already has a verified business profile.',
  );
});

test('a suspended profile frees the place even though the old verified claim remains', () => {
  // The verified claim row stays as history; the profile's status is what
  // holds the place, so a suspended one opens it for a new claimant.
  const ctx = {
    ...openCtx,
    profile: { id: '9', status: 'suspended' },
    activeClaim: { id: '7', claimant_user_id: '2', status: 'verified' },
  };
  assert.equal(model.canClaim(OWNER, ctx), true);
  // But someone else's PENDING claim still blocks, suspended profile or not.
  const pending = {
    ...ctx,
    activeClaim: { id: '8', claimant_user_id: '2', status: 'pending' },
  };
  assert.equal(model.canClaim(OWNER, pending), false);
  assert.ok(model.claimBlockReason(OWNER, pending).includes('already has an active claim'));
});

test('login is never proof of ownership: claiming is an application for anyone', () => {
  assert.equal(model.canClaim(OWNER, openCtx), true);
  assert.equal(model.canClaim(SOMEONE, openCtx), true);
  // A forged owner flag on the viewer changes nothing — the flag is not a
  // field the model reads.
  assert.equal(model.canClaim({ ...OWNER, reviewer: true }, openCtx), true);
});

test('the pending-claim cap is three per person', () => {
  const full = { ...openCtx, myPendingCount: model.LIMITS.pendingClaimsPerUser };
  assert.equal(model.canClaim(OWNER, full), false);
  assert.ok(model.claimBlockReason(OWNER, full).includes('3'));
  // And one below the cap is still fine.
  assert.equal(model.canClaim(OWNER, { ...openCtx, myPendingCount: 2 }), true);
});

test('an active claim by someone else blocks a second claim, with the honest reason', () => {
  const ctx = { ...openCtx, activeClaim: { id: '7', claimant_user_id: '2', status: 'pending' } };
  assert.equal(model.canClaim(OWNER, ctx), false);
  assert.ok(model.claimBlockReason(OWNER, ctx).includes('already has an active claim'));
});

test('the viewer\'s own pending claim on the place blocks a duplicate', () => {
  const ctx = { ...openCtx, myPending: true };
  assert.equal(model.canClaim(OWNER, ctx), false);
  assert.ok(model.claimBlockReason(OWNER, ctx).includes('already have a claim pending'));
});

test('a rejection starts a 7-day cool-down, then the place is claimable again', () => {
  const rejectedAt = new Date('2026-10-10T12:00:00Z');
  const early = { ...openCtx, lastRejectionAt: rejectedAt };
  assert.equal(model.canClaim(OWNER, early), false);
  assert.ok(model.claimBlockReason(OWNER, early).includes('7 days'));

  const after = { ...openCtx, lastRejectionAt: rejectedAt, now: new Date('2026-10-17T12:00:01Z') };
  assert.equal(model.canClaim(OWNER, after), true);
});

// ── editing, moderating, flagging ────────────────────────────────────────

test('only the verified owner may edit an active profile', () => {
  const profile = { ownerUserId: '1', status: 'active' };
  assert.equal(model.canEditProfile(OWNER, profile), true);
  assert.equal(model.canEditProfile(SOMEONE, profile), false);
  const suspended = { ownerUserId: '1', status: 'suspended' };
  assert.equal(model.canEditProfile(OWNER, suspended), false);
  assert.ok(model.editBlockReason(OWNER, suspended).includes('suspended'));
});

test('the audit trail is for the owner and reviewers only', () => {
  const profile = { ownerUserId: '1', status: 'active' };
  assert.equal(model.canViewAudit(OWNER, profile), true);
  assert.equal(model.canViewAudit(REVIEWER, profile), true);
  assert.equal(model.canViewAudit(SOMEONE, profile), false);
});

test('anyone but the owner may flag an active profile, once', () => {
  const profile = { ownerUserId: '1', status: 'active' };
  assert.equal(model.canFlag(SOMEONE, profile), true);
  assert.equal(model.canFlag(OWNER, profile), false);
  assert.ok(model.flagBlockReason(OWNER, profile).includes('own'));
  assert.equal(model.canFlag(SOMEONE, { ...profile, status: 'suspended' }), false);
});

// ── validation ───────────────────────────────────────────────────────────

function claimBody(overrides = {}) {
  return {
    place: {
      id: 'place-abc-123',
      name: 'Kiosk am Park',
      address: 'Am Park 12, Berlin',
      category: 'Kiosk',
      lat: 52.5301,
      lng: 13.4014,
    },
    contactValue: 'owner@example.test',
    evidence: [evidenceItem()],
    ...overrides,
  };
}

test('a valid claim body comes back cleaned', () => {
  const out = model.validateClaim(claimBody(), { platformOrigin: 'https://platform.test' });
  assert.equal(out.place.id, 'place-abc-123');
  assert.equal(out.place.name, 'Kiosk am Park');
  assert.equal(out.contactValue, 'owner@example.test');
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].id, 'a'.repeat(32));
  assert.equal(out.evidence[0].url, `https://platform.test/app-files/${'a'.repeat(32)}`);
});

test('an invalid claim names each broken field', () => {
  try {
    model.validateClaim(
      claimBody({
        place: { id: '', name: '' },
        contactValue: 'hi',
        evidence: [{ url: 'https://evil.test/app-files/' + 'a'.repeat(32) }],
      }),
      { platformOrigin: 'https://platform.test' },
    );
    assert.fail('expected a throw');
  } catch (err) {
    assert.equal(err.code, 'invalid_claim');
    assert.ok(err.fields.place);
    assert.ok(err.fields.contactValue);
    assert.ok(err.fields.evidence);
  }
});

test('evidence must be platform-stored images, at most three', () => {
  const fields = {};
  // A non-image content type is refused.
  assert.throws(
    () => model.validateClaim(claimBody({ evidence: [{ ...evidenceItem(), contentType: 'application/pdf' }] })),
    (err) => err.code === 'invalid_claim' && !!err.fields.evidence,
  );
  // A non /app-files/ path is refused — an arbitrary link is not a photo of
  // a licence.
  assert.throws(
    () => model.validateClaim(claimBody({ evidence: [{ url: 'https://platform.test/other/' + 'a'.repeat(32) }] })),
    (err) => err.code === 'invalid_claim' && !!err.fields.evidence,
  );
  // Four photos is one too many.
  assert.throws(
    () => model.validateClaim(claimBody({ evidence: [evidenceItem(), evidenceItem(), evidenceItem(), evidenceItem()] })),
    (err) => err.code === 'invalid_claim' && !!err.fields.evidence,
  );
  // Empty evidence is fine (fields stays untouched).
  const ok = model.validateClaim(claimBody({ evidence: [] }));
  assert.deepEqual(ok.evidence, []);
  assert.equal(fields.evidence, undefined);
});

test('a rejection decision needs a reason code; a note is optional', () => {
  const ok = model.validateDecision({ status: 'rejected', reason: 'insufficient_evidence' });
  assert.equal(ok.status, 'rejected');
  assert.equal(ok.reason, 'insufficient_evidence');
  const withNote = model.validateDecision({ status: 'verified', note: 'Licence matches.' });
  assert.equal(withNote.note, 'Licence matches.');
  assert.throws(
    () => model.validateDecision({ status: 'rejected' }),
    (err) => err.code === 'invalid_decision' && !!err.fields.reason,
  );
  assert.throws(
    () => model.validateDecision({ status: 'pending' }),
    (err) => err.code === 'invalid_decision' && !!err.fields.status,
  );
});

test('a profile patch is at least one changed field, within the limits', () => {
  const one = model.validateProfilePatch({ phone: ' +49 30 000000 ' });
  assert.deepEqual(one, { phone: '+49 30 000000' });
  const many = model.validateProfilePatch({ name: 'New name', hours: 'Mon-Fri 9-5' });
  assert.equal(many.name, 'New name');
  assert.throws(
    () => model.validateProfilePatch({}),
    (err) => err.code === 'invalid_patch' && !!err.fields.profile,
  );
  assert.throws(
    () => model.validateProfilePatch({ website: 'not-a-url' }),
    (err) => err.code === 'invalid_patch' && !!err.fields.website,
  );
  assert.throws(
    () => model.validateProfilePatch({ name: '' }),
    (err) => err.code === 'invalid_patch' && !!err.fields.name,
  );
});

// ── configuration and helpers ────────────────────────────────────────────

test('reviewer configuration parses case-insensitively, empty is valid', () => {
  assert.deepEqual([...model.parseReviewers('Rita, ron ')].sort(), ['rita', 'ron']);
  assert.equal(model.parseReviewers('').size, 0);
  assert.equal(model.parseReviewers(null).size, 0);
});

test('queue queries clamp paging and default to the pending view', () => {
  assert.deepEqual(model.parseQueueQuery({}), { view: 'pending', limit: 20, offset: 0 });
  assert.equal(model.parseQueueQuery({ view: 'superseded' }).view, 'superseded');
  assert.equal(model.parseQueueQuery({ view: 'nonsense' }).view, 'pending');
  assert.equal(model.parseQueueQuery({ limit: '999' }).limit, model.LIMITS.pageMax);
  assert.equal(model.parseQueueQuery({ limit: '-3' }).limit, model.LIMITS.pageDefault);
  assert.equal(model.parseQueueQuery({ offset: '9' }).offset, 9);
  assert.equal(model.parseQueueQuery({ offset: '-1' }).offset, 0);
});

test('daysLeft counts down to the 30-day expiry and never goes negative', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  assert.equal(model.daysLeft({ status: 'pending', expiresAt: '2026-11-11T12:00:00Z' }, now), 30);
  assert.equal(model.daysLeft({ status: 'pending', expiresAt: '2026-10-12T18:00:00Z' }, now), 1);
  assert.equal(model.daysLeft({ status: 'pending', expiresAt: '2026-10-01T12:00:00Z' }, now), 0);
  // A decided claim has nothing left to count.
  assert.equal(model.daysLeft({ status: 'rejected', expiresAt: '2026-11-11T12:00:00Z' }, now), null);
});
