// Business store and routes against a REAL Postgres database (Phase 12J).
//
// Each run creates its own throwaway schema, applies the boot migration and
// drives the actual HTTP routes (business/routes.js over business/store.js)
// with an express app whose only stand-in is the identity: a header names
// the signed-in person, as the platform token would. Nothing in the code
// under test is stubbed.
//
// The spec's five test families, as ordered slices:
//   authorization  login is not proof of ownership; only the claimant may
//                  withdraw; only a configured reviewer may decide, queue,
//                  moderate; only the owner may edit.
//   concurrent     two claimants racing one place: exactly one pending claim
//                  survives, the loser gets a typed 409.
//   privacy        contact_value and evidence URLs leave the app ONLY through
//                  the reviewer queue and decision responses; the claimant's
//                  and the public payloads never carry them, and audit event
//                  detail is redacted.
//   validation     invalid claim bodies, empty patches and malformed
//                  decisions name their fields instead of reaching the DB.
//   localization   covered by tests/business.i18n.test.js (pure bundles).
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL (the build
// worker's local Postgres). Skipped, loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createBusinessStore, ROLLBACK_SQL, resetBuckets } = require('../business/store');
const { createBusinessRouter } = require('../business/routes');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const ORIGIN = 'https://platform.test';
const FILE = (n) => `${ORIGIN}/app-files/${String(n).repeat(32).slice(0, 32)}`;

const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let base;
const schema = `business_test_${process.pid}_${Date.now()}`;

async function call(method, path, { as = 'alice', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const USERS = {
  alice: { id: 101, username: 'alice' },
  bob: { id: 102, username: 'bob' },
  carol: { id: 103, username: 'carol' },
  rita: { id: 104, username: 'Rita' }, // a reviewer, matched case-insensitively
};

// A place ref as the search stack would hand it over (search/normalize.js).
function placeRef(id, name) {
  return { id, name, address: 'Am Park 12, Berlin', category: 'Kiosk', lat: 52.5301, lng: 13.4014 };
}

function claimBody(overrides = {}) {
  return {
    place: placeRef('demo-kiosk-1', 'Kiosk am Park'),
    contactValue: 'alice@example.test',
    evidence: [{ url: FILE('a'), contentType: 'image/png', filename: 'licence.png' }],
    ...overrides,
  };
}

async function verifiedProfile(as, placeId, placeName) {
  const submitted = await call('POST', `/place/${placeId}/claim`, {
    as,
    body: claimBody({ place: placeRef(placeId, placeName) }),
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const queue = await call('GET', '/queue', { as: 'rita' });
  const row = queue.body.items.find((x) => x.placeId === placeId);
  assert.ok(row, 'the claim reached the queue');
  const decided = await call('POST', `/claims/${row.id}/decision`, {
    as: 'rita',
    body: { status: 'verified', note: 'ok' },
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  return decided.body;
}

// Later tests start from a clean slate: withdraw whatever pending claims the
// viewer still carries from an earlier test, so the per-person cap is
// measured against this test's own claims only.
async function withdrawPending(as) {
  const mine = (await call('GET', '/mine', { as })).body;
  for (const claim of mine.claims.filter((c) => c.status === 'pending' && c.viewer.canWithdraw)) {
    await call('POST', `/claims/${claim.id}/withdraw`, { as });
  }
}

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  const store = createBusinessStore({ pool, platformOrigin: ORIGIN });
  await store.migrate();
  await store.migrate(); // the boot migration must be idempotent
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']];
    next();
  });
  app.use('/api/business', createBusinessRouter({ store, reviewers: new Set(['rita']) }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/business`;
});

test.after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

// ── reads and validation ─────────────────────────────────────────────────

test('meta reports the limits and whether the viewer is a reviewer', { skip }, async () => {
  const mine = await call('GET', '/meta', { as: 'rita' });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.viewer.reviewer, true);
  assert.equal(mine.body.limits.evidenceMax, 3);
  const notReviewer = await call('GET', '/meta', { as: 'alice' });
  assert.equal(notReviewer.body.viewer.reviewer, false);
});

test('an unclaimed place answers claimable, with nothing invented', { skip }, async () => {
  resetBuckets();
  const state = await call('GET', '/place/demo-empty-1', { as: 'alice' });
  assert.equal(state.status, 200);
  assert.equal(state.body.placeId, 'demo-empty-1');
  assert.equal(state.body.profile, null);
  assert.equal(state.body.myClaim, null);
  assert.equal(state.body.viewer.canClaim, true);
  assert.equal(state.body.viewer.claimBlockedReason, null);
});

test('claim validation errors name each field before anything is stored', { skip }, async () => {
  resetBuckets();
  const bad = await call('POST', '/place/demo-kiosk-x/claim', {
    body: {
      place: { id: 'demo-kiosk-x', name: '' },
      contactValue: 'hi',
      evidence: [{ url: 'https://evil.test/app-files/' + 'a'.repeat(32) }],
    },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_claim');
  assert.ok(bad.body.error.fields.place);
  assert.ok(bad.body.error.fields.contactValue);
  assert.ok(bad.body.error.fields.evidence);
  const rows = await pool.query("SELECT count(*)::int AS n FROM business_claims WHERE place_id = 'demo-kiosk-x'");
  assert.equal(rows.rows[0].n, 0);
});

// ── the happy path, end to end ───────────────────────────────────────────

test('claim, verify, and the place page flips to the verified profile', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-flow-bakery-1';
  const submitted = await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Corner Bakery') }),
  });
  assert.equal(submitted.status, 200);
  const claim = submitted.body;
  assert.equal(claim.status, 'pending');
  assert.equal(claim.viewer.isClaimant, true);
  assert.equal(claim.viewer.canWithdraw, true);
  assert.equal(claim.evidenceCount, 1);
  assert.equal(claim.daysLeft, 30);
  // Privacy first: the claimant's own view of their fresh claim carries no
  // contact value and no evidence URL.
  assert.equal(claim.contactValue, undefined);
  assert.equal(claim.evidence, undefined);
  // The URL path segment is authoritative: a body place id cannot move the
  // claim to another place.
  assert.equal(claim.placeId, placeId);
  const hijack = await call('POST', `/place/${placeId}2/claim`, {
    body: { ...claimBody(), place: placeRef(placeId, 'Corner Bakery') },
  });
  assert.equal(hijack.status, 200);
  assert.equal(hijack.body.placeId, `${placeId}2`);
  await call('POST', `/claims/${hijack.body.id}/withdraw`, { as: 'alice' });

  // A non-reviewer cannot decide it; a reviewer can.
  const notReviewer = await call('POST', `/claims/${claim.id}/decision`, {
    as: 'bob',
    body: { status: 'verified' },
  });
  assert.equal(notReviewer.status, 403);
  assert.equal(notReviewer.body.error.code, 'forbidden');

  const decided = await call('POST', `/claims/${claim.id}/decision`, {
    as: 'rita',
    body: { status: 'verified', note: 'Licence matches the address.' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.claim.status, 'verified');
  assert.ok(decided.body.profileId);

  // The place page now shows the verified profile; another person sees it
  // but cannot edit or flag it as its owner.
  const asOwner = await call('GET', `/place/${placeId}`, { as: 'alice' });
  assert.equal(asOwner.body.profile.status, 'active');
  assert.equal(asOwner.body.profile.owner.username, 'alice');
  assert.equal(asOwner.body.profile.viewer.isOwner, true);
  assert.equal(asOwner.body.profile.viewer.canEdit, true);
  // The public shape names the owner by username only.
  assert.equal(asOwner.body.profile.owner_user_id, undefined);
  assert.equal(asOwner.body.profile.owner.id, undefined);
  const asSomeone = await call('GET', `/place/${placeId}`, { as: 'carol' });
  assert.equal(asSomeone.body.profile.viewer.isOwner, false);
  assert.equal(asSomeone.body.profile.viewer.canEdit, false);
  assert.equal(asSomeone.body.profile.viewer.canFlag, true);
  assert.equal(asSomeone.body.viewer.canClaim, false);
  assert.ok(asSomeone.body.viewer.claimBlockedReason.includes('verified business profile'));

  // The dashboard lists it under "my businesses".
  const mine = await call('GET', '/mine', { as: 'alice' });
  assert.ok(mine.body.profiles.some((p) => p.id === decided.body.profileId));
  assert.ok(mine.body.claims.some((c) => c.id === claim.id));

  // The owner edits; the patch lands, and the profile gains a revision.
  const edited = await call('PATCH', `/profiles/${decided.body.profileId}`, {
    body: { phone: '+49 30 000000', website: 'https://bakery.example' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.phone, '+49 30 000000');
  const audit = await call('GET', `/profiles/${decided.body.profileId}`, { as: 'alice' });
  assert.equal(audit.body.revisions.length, 2);
  assert.equal(audit.body.revisions[0].seq, 0);
  assert.equal(audit.body.revisions[1].seq, 1);
  assert.ok(audit.body.events.some((e) => e.type === 'claim_verified'));
  assert.ok(audit.body.events.some((e) => e.type === 'profile_edited'));

  // A stranger gets the profile but NOT the audit trail.
  const strangerAudit = await call('GET', `/profiles/${decided.body.profileId}`, { as: 'bob' });
  assert.equal(strangerAudit.body.revisions, undefined);
  assert.equal(strangerAudit.body.events, undefined);
  assert.equal(strangerAudit.body.flags, undefined);
});

// ── authorization ────────────────────────────────────────────────────────

test('only the claimant can withdraw, and only while pending', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-withdraw-1';
  const claim = (await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Withdraw Target') }),
  })).body;
  // Another person cannot withdraw someone else's claim.
  const notMine = await call('POST', `/claims/${claim.id}/withdraw`, { as: 'bob' });
  assert.equal(notMine.status, 403);
  assert.equal(notMine.body.error.code, 'forbidden');
  // The claimant can, and the place becomes claimable again.
  const withdrawn = await call('POST', `/claims/${claim.id}/withdraw`, { as: 'alice' });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, 'withdrawn');
  // Withdrawn claims cannot be withdrawn again or decided.
  const again = await call('POST', `/claims/${claim.id}/withdraw`, { as: 'alice' });
  assert.equal(again.status, 409);
  const decided = await call('POST', `/claims/${claim.id}/decision`, {
    as: 'rita',
    body: { status: 'verified' },
  });
  assert.equal(decided.status, 403); // superseded-only transitions reject it
  const state = await call('GET', `/place/${placeId}`, { as: 'bob' });
  assert.equal(state.body.viewer.canClaim, true);
});

test('only a configured reviewer sees the queue and can moderate', { skip }, async () => {
  const queue = await call('GET', '/queue', { as: 'bob' });
  assert.equal(queue.status, 403);
  assert.equal(queue.body.error.code, 'forbidden');
  // The dashboard honestly says so rather than hiding the tab silently.
  const moderate = await call('POST', '/profiles/940001/moderate', {
    as: 'carol',
    body: { status: 'suspended' },
  });
  assert.equal(moderate.status, 403);

  // A reviewer can suspend and reinstate; a same-status move is a 409.
  await verifiedProfile('bob', 'demo-moderate-1', 'Moderation Target');
  const profiles = (await call('GET', '/mine', { as: 'bob' })).body.profiles;
  const profileId = profiles[0].id;
  const suspended = await call('POST', `/profiles/${profileId}/moderate`, {
    as: 'rita',
    body: { status: 'suspended', note: 'Reported as closed.' },
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.status, 'suspended');
  const same = await call('POST', `/profiles/${profileId}/moderate`, {
    as: 'rita',
    body: { status: 'suspended' },
  });
  assert.equal(same.status, 409);
  // A suspended profile is frozen for its owner until reinstated.
  const frozen = await call('PATCH', `/profiles/${profileId}`, { as: 'bob', body: { phone: '000' } });
  assert.equal(frozen.status, 403);
  const reinstated = await call('POST', `/profiles/${profileId}/moderate`, {
    as: 'rita',
    body: { status: 'active' },
  });
  assert.equal(reinstated.status, 200);
  assert.equal(reinstated.body.status, 'active');
  const thawed = await call('PATCH', `/profiles/${profileId}`, { as: 'bob', body: { phone: '+49 111111' } });
  assert.equal(thawed.status, 200);
});

test('a forged owner or reviewer field in the body changes nothing', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-forge-1';
  const submitted = await call('POST', `/place/${placeId}/claim`, {
    as: 'carol',
    body: { ...claimBody({ place: placeRef(placeId, 'Forge Target') }), ownerUserId: '101', reviewer: true },
  });
  assert.equal(submitted.status, 200);
  // The claim still belongs to carol, not to the forged id.
  assert.equal(submitted.body.viewer.isClaimant, true);
  const alicesView = await call('GET', `/place/${placeId}`, { as: 'alice' });
  assert.equal(alicesView.body.myClaim, null);
  // And a forged reviewer flag does not open the queue.
  const queue = await call('GET', '/queue?reviewer=1', { as: 'carol' });
  assert.equal(queue.status, 403);
  await call('POST', `/claims/${submitted.body.id}/withdraw`, { as: 'carol' });
});

// ── concurrent claims ────────────────────────────────────────────────────

test('two claimants racing one place: one pending claim survives, the loser gets a 409', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-race-1';
  const [aliceRes, bobRes] = await Promise.all([
    call('POST', `/place/${placeId}/claim`, { as: 'alice', body: claimBody({ place: placeRef(placeId, 'Race Cafe') }) }),
    call('POST', `/place/${placeId}/claim`, { as: 'bob', body: claimBody({ place: placeRef(placeId, 'Race Cafe') }) }),
  ]);
  assert.equal(aliceRes.status, 200);
  assert.equal(bobRes.status, 409);
  assert.equal(bobRes.body.error.code, 'claim_conflict');
  assert.ok(bobRes.body.error.message.includes('already has an active claim'));
  // Exactly one pending claim for the place.
  const rows = await pool.query(
    "SELECT count(*)::int AS n FROM business_claims WHERE place_id = $1 AND status = 'pending'",
    [placeId],
  );
  assert.equal(rows.rows[0].n, 1);
  // The place page tells the loser the truth.
  const losersView = await call('GET', `/place/${placeId}`, { as: 'bob' });
  assert.equal(losersView.body.viewer.canClaim, false);
  assert.ok(losersView.body.viewer.claimBlockedReason.includes('already has an active claim'));
  await call('POST', `/claims/${aliceRes.body.id}/withdraw`, { as: 'alice' });
});

test('the same person cannot stack two pending claims on one place', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-double-1';
  const first = await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Double Kiosk') }),
  });
  assert.equal(first.status, 200);
  const second = await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Double Kiosk') }),
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'claim_conflict');
  await call('POST', `/claims/${first.body.id}/withdraw`, { as: 'alice' });
});

test('the pending-claims cap is three per person', { skip }, async () => {
  resetBuckets();
  await withdrawPending('alice');
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const placeId = `demo-cap-${i}`;
    const res = await call('POST', `/place/${placeId}/claim`, {
      body: claimBody({ place: placeRef(placeId, `Cap Target ${i}`) }),
    });
    assert.equal(res.status, 200, `claim ${i}`);
    ids.push(res.body.id);
  }
  const fourth = await call('POST', '/place/demo-cap-3/claim', {
    body: claimBody({ place: placeRef('demo-cap-3', 'Cap Target 4') }),
  });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'claims_limit');
  for (const id of ids) await call('POST', `/claims/${id}/withdraw`, { as: 'alice' });
});

// ── rejection, cool-down, expiry ─────────────────────────────────────────

test('a rejection names its reason, and the 7-day cool-down holds', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-cooldown-1';
  const claim = (await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Cool Down Cafe') }),
  })).body;
  // A malformed decision is refused before anything moves.
  const malformed = await call('POST', `/claims/${claim.id}/decision`, {
    as: 'rita',
    body: { status: 'rejected' },
  });
  assert.equal(malformed.status, 400);
  assert.ok(malformed.body.error.fields.reason);

  const rejected = await call('POST', `/claims/${claim.id}/decision`, {
    as: 'rita',
    body: { status: 'rejected', reason: 'insufficient_evidence', note: 'Photos do not show the address.' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.claim.status, 'rejected');
  assert.equal(rejected.body.claim.decisionReason, 'insufficient_evidence');
  // The claimant sees the reviewer's name on their own claim.
  assert.equal(rejected.body.claim.decidedBy, 'Rita');

  // The dashboard shows the rejected reason to the claimant.
  const mine = await call('GET', '/mine', { as: 'alice' });
  const shown = mine.body.claims.find((c) => c.id === claim.id);
  assert.equal(shown.decisionReason, 'insufficient_evidence');
  assert.equal(shown.contactValue, undefined);
  assert.equal(shown.evidence, undefined);

  // The cool-down holds for 7 days.
  const blocked = await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Cool Down Cafe') }),
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'cool_down');
  // The place page says so, too.
  const state = await call('GET', `/place/${placeId}`, { as: 'alice' });
  assert.equal(state.body.viewer.canClaim, false);
  assert.ok(state.body.viewer.claimBlockedReason.includes('7 days'));
});

test('a pending claim past 30 days expires to withdrawn, never verified', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-expiry-1';
  const claim = (await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Expiry Kiosk') }),
  })).body;
  // Push its expiry into the past, as thirty days of silence would.
  await pool.query(
    "UPDATE business_claims SET expires_at = now() - interval '1 day' WHERE id = $1",
    [claim.id],
  );
  // Any read applies the lazy sweep.
  const state = await call('GET', `/place/${placeId}`, { as: 'alice' });
  assert.equal(state.body.myClaim.status, 'withdrawn');
  assert.equal(state.body.viewer.canClaim, true);
  // The audit says the system did it.
  const events = await pool.query(
    "SELECT event_type, actor_username FROM business_profile_events WHERE claim_id = $1 ORDER BY id",
    [claim.id],
  );
  assert.ok(events.rows.some((r) => r.event_type === 'claim_expired' && r.actor_username === 'system'));
  // And nothing verified appeared: no profile for the place.
  const profiles = await pool.query('SELECT count(*)::int AS n FROM business_profiles WHERE place_id = $1', [placeId]);
  assert.equal(profiles.rows[0].n, 0);
});

// ── privacy (the spec's R-4g) ────────────────────────────────────────────

test('contact and evidence leave the app only through the reviewer surfaces', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-privacy-1';
  const evidence = [
    { url: FILE('b'), contentType: 'image/png', filename: 'licence.png' },
    { url: FILE('c'), contentType: 'image/jpeg', filename: 'counter.jpg' },
  ];
  const contactValue = 'alice-private-contact@example.test';
  const claim = (await call('POST', `/place/${placeId}/claim`, {
    body: claimBody({ place: placeRef(placeId, 'Privacy Cafe'), contactValue, evidence }),
  })).body;

  // The claimant's own payload: no contact value, no evidence URLs.
  assert.equal(claim.contactValue, undefined);
  assert.equal(claim.evidence, undefined);
  assert.equal(claim.evidenceCount, 2);
  const mine = await call('GET', '/mine', { as: 'alice' });
  const mineRow = mine.body.claims.find((c) => c.id === claim.id);
  assert.equal(mineRow.contactValue, undefined);
  assert.equal(mineRow.evidence, undefined);

  // The queue is the only surface that carries them.
  const queue = await call('GET', '/queue', { as: 'rita' });
  const reviewRow = queue.body.items.find((c) => c.id === claim.id);
  assert.ok(reviewRow, 'the claim is in the queue');
  assert.equal(reviewRow.contactValue, contactValue);
  assert.deepEqual(reviewRow.evidence.map((e) => e.url), evidence.map((e) => e.url));
  // The raw rows in the database hold them too, of course — the assertion is
  // that no OTHER payload does.
  const stored = await pool.query('SELECT contact_value, evidence FROM business_claims WHERE id = $1', [claim.id]);
  assert.equal(stored.rows[0].contact_value, contactValue);
  assert.equal(stored.rows[0].evidence.length, 2);

  // The audit event detail is redacted: counts only, never values or links.
  const events = await pool.query(
    'SELECT detail FROM business_profile_events WHERE claim_id = $1',
    [claim.id],
  );
  for (const row of events.rows) {
    const detail = JSON.stringify(row.detail || {});
    assert.ok(!detail.includes(contactValue), 'audit detail never carries the contact value');
    assert.ok(!detail.includes('/app-files/'), 'audit detail never carries an evidence URL');
  }

  // The decision response is a reviewer surface: it may carry them. The
  // claimant's view of the decided claim stays redacted.
  const decided = await call('POST', `/claims/${claim.id}/decision`, {
    as: 'rita',
    body: { status: 'verified' },
  });
  assert.equal(decided.body.claim.contactValue, contactValue);
  const decidedMine = await call('GET', '/mine', { as: 'alice' });
  const decidedRow = decidedMine.body.claims.find((c) => c.id === claim.id);
  assert.equal(decidedRow.contactValue, undefined);
  assert.equal(decidedRow.evidence, undefined);
});

// ── flags ────────────────────────────────────────────────────────────────

test('flagging: anyone but the owner, once per person, audited', { skip }, async () => {
  resetBuckets();
  await verifiedProfile('bob', 'demo-flag-1', 'Flagged Cafe');
  const profiles = (await call('GET', '/mine', { as: 'bob' })).body.profiles;
  const profileId = profiles.find((p) => p.placeId === 'demo-flag-1').id;

  // The owner cannot flag their own business.
  const own = await call('POST', `/profiles/${profileId}/flag`, {
    as: 'bob',
    body: { reason: 'test' },
  });
  assert.equal(own.status, 403);
  // Someone else can; a second flag by the same person is a no-op.
  const first = await call('POST', `/profiles/${profileId}/flag`, {
    as: 'carol',
    body: { reason: 'Opening hours look wrong.' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'flagged');
  const second = await call('POST', `/profiles/${profileId}/flag`, {
    as: 'carol',
    body: { reason: 'Again' },
  });
  assert.equal(second.body.outcome, 'already');
  // The reviewer sees the flags in the profile's audit view; a stranger does
  // not see them at all.
  const asReviewer = await call('GET', `/profiles/${profileId}`, { as: 'rita' });
  assert.equal(asReviewer.body.flags.length, 1);
  assert.equal(asReviewer.body.flags[0].flagger, 'carol');
  const asStranger = await call('GET', `/profiles/${profileId}`, { as: 'carol' });
  assert.equal(asStranger.body.flags, undefined);
});

// ── superseded: the losing attempt and the ownership-swap path ───────────

test('a losing claim is recorded as superseded and can take over once the winner is gone', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-swap-1';
  // Alice claims first (pending); Bob submits later and loses.
  const winner = (await call('POST', `/place/${placeId}/claim`, {
    as: 'alice',
    body: claimBody({ place: placeRef(placeId, 'Swap Cafe') }),
  })).body;
  const losers = await call('POST', `/place/${placeId}/claim`, {
    as: 'bob',
    body: claimBody({ place: placeRef(placeId, 'Swap Cafe') }),
  });
  assert.equal(losers.status, 409);
  assert.equal(losers.body.error.code, 'claim_conflict');
  // The losing attempt was still recorded, as superseded: a reviewer can
  // later see who else tried for this place.
  const loserRows = await pool.query(
    "SELECT id, status FROM business_claims WHERE place_id = $1 AND claimant_user_id = '102'",
    [placeId],
  );
  assert.equal(loserRows.rows.length, 1);
  assert.equal(loserRows.rows[0].status, 'superseded');
  const loserId = String(loserRows.rows[0].id);

  // While the winner is active, verifying the superseded claim is refused.
  const whileActive = await call('POST', `/claims/${loserId}/decision`, {
    as: 'rita',
    body: { status: 'verified' },
  });
  assert.equal(whileActive.status, 403);
  assert.ok(whileActive.body.error.message.includes('still active'));
  // And it is visible in the queue's superseded view.
  const supersededView = await call('GET', '/queue?view=superseded', { as: 'rita' });
  assert.ok(supersededView.body.items.some((c) => c.id === loserId));

  // The winner withdraws; now the superseded claim can take over.
  await call('POST', `/claims/${winner.id}/withdraw`, { as: 'alice' });
  const swap = await call('POST', `/claims/${loserId}/decision`, {
    as: 'rita',
    body: { status: 'verified' },
  });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));
  assert.equal(swap.body.claim.status, 'verified');
  const state = await call('GET', `/place/${placeId}`, { as: 'bob' });
  assert.equal(state.body.profile.owner.username, 'bob');
  // No profile existed (the winner never verified), so this is a creation.
  const events = await pool.query(
    'SELECT event_type FROM business_profile_events WHERE profile_id = $1 ORDER BY id',
    [swap.body.profileId],
  );
  assert.ok(events.rows.some((r) => r.event_type === 'profile_created'));
});

test('a suspended profile frees the place; verifying a new claim transfers ownership', { skip }, async () => {
  resetBuckets();
  const placeId = 'demo-transfer-1';
  const first = await verifiedProfile('alice', placeId, 'Transfer Cafe');
  // While the profile is active, the place is not claimable.
  const blocked = await call('POST', `/place/${placeId}/claim`, {
    as: 'carol',
    body: claimBody({ place: placeRef(placeId, 'Transfer Cafe') }),
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'not_claimable');
  // A reviewer suspends the profile; the place opens up again.
  const suspended = await call('POST', `/profiles/${first.profileId}/moderate`, {
    as: 'rita',
    body: { status: 'suspended', note: 'Owner unreachable.' },
  });
  assert.equal(suspended.status, 200);
  const state = await call('GET', `/place/${placeId}`, { as: 'carol' });
  assert.equal(state.body.profile.status, 'suspended');
  assert.equal(state.body.viewer.canClaim, true);
  const second = await call('POST', `/place/${placeId}/claim`, {
    as: 'carol',
    body: claimBody({ place: placeRef(placeId, 'Transfer Cafe') }),
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const decided = await call('POST', `/claims/${second.body.id}/decision`, {
    as: 'rita',
    body: { status: 'verified' },
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  // The same profile row, a new owner, active again — audited as a transfer.
  assert.equal(decided.body.profileId, first.profileId);
  const after = await call('GET', `/place/${placeId}`, { as: 'carol' });
  assert.equal(after.body.profile.owner.username, 'carol');
  assert.equal(after.body.profile.status, 'active');
  const events = await pool.query(
    'SELECT event_type FROM business_profile_events WHERE profile_id = $1 ORDER BY id',
    [first.profileId],
  );
  assert.ok(events.rows.some((r) => r.event_type === 'ownership_transferred'));
});

// ── rollback ─────────────────────────────────────────────────────────────

test('the rollback SQL undoes the migration, and the migration reapplies', { skip }, async () => {
  const { rows: before } = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'business_%'",
    [schema],
  );
  assert.ok(before[0].n >= 5, 'the five business tables exist');
  await pool.query(ROLLBACK_SQL);
  const { rows: after } = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'business_%'",
    [schema],
  );
  assert.equal(after[0].n, 0, 'rollback drops every business table');
  // The store re-migrates cleanly (the boot path after an operator rollback).
  const store = createBusinessStore({ pool, platformOrigin: ORIGIN });
  await store.migrate();
  const { rows: back } = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'business_%'",
    [schema],
  );
  assert.equal(back[0].n, 5);
});

// ── staging seed ─────────────────────────────────────────────────────────

test('staging seed is idempotent and never involves a real person', { skip }, async () => {
  const store = createBusinessStore({ pool, platformOrigin: ORIGIN });
  await store.seedStaging();
  await store.seedStaging();
  const profiles = await pool.query("SELECT count(*)::int AS n FROM business_profiles WHERE owner_user_id LIKE 'staging-demo-%'");
  assert.equal(profiles.rows[0].n, 1);
  const claims = await pool.query(
    "SELECT status, count(*)::int AS n FROM business_claims WHERE claimant_user_id LIKE 'staging-demo-%' GROUP BY status",
  );
  const byStatus = Object.fromEntries(claims.rows.map((r) => [r.status, r.n]));
  assert.equal(byStatus.pending, 1);
  assert.equal(byStatus.verified, 1);
  assert.equal(byStatus.rejected, 1);
  // The seeded pending claim is visible in the reviewer queue with its
  // contact value (the one surface allowed to show it).
  const queue = await call('GET', '/queue', { as: 'rita' });
  const demo = queue.body.items.find((c) => c.placeId === 'staging-demo:kiosk-am-park');
  assert.ok(demo, 'the seeded pending claim is in the queue');
  assert.ok(String(demo.contactValue).startsWith('Staging demo contact:'));
});
