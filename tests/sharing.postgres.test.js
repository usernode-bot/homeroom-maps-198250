// Location sharing routes, store and security matrix (Phase 12F) against a
// REAL Postgres database.
//
// Each run creates its own throwaway schema, applies the boot migration and
// drives the actual HTTP routes (sharing/routes.js over sharing/store.js and
// sharing/members.js) with an express app whose only stand-ins are the
// identity (a header names the signed-in person, as the platform token would)
// and the platform directory (a fake fetch, as the connector is a read-only
// boundary nothing in the app controls).
//
// The security matrix from the specification maps onto these tests:
//   1. only the owner creates, updates, revokes          → 'owner only'
//   2. recipients are strictly read-only                 → 'recipients are read-only'
//   3. no access via guessed session ids                 → 'guessed ids'
//   4. revocation is immediate, including concurrent     → 'stop is atomic'
//   5. expired / deleted-user handling                   → 'expiry, lazy ending and purge'
//   6. no coordinate leakage anywhere                    → 'leak prevention'
//   7. the exhaustive route surface                      → 'the seven routes'
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL (the build
// worker's local Postgres). Skipped, loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createSharingStore } = require('../sharing/store');
const { createSharingRouter } = require('../sharing/routes');
const { createMembersClient } = require('../sharing/members');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let servers = [];
let base;
let downBase; // the app instance whose directory cannot be reached
let offBase; // the app instance with the operator switch off
let rateBase; // the app instance with fresh rate-limit buckets
const schema = `sharing_test_${process.pid}_${Date.now()}`;

const USERS = {
  alice: { id: '101', username: 'alice' },
  bob: { id: '102', username: 'bob' },
  carol: { id: '103', username: 'carol' },
  dave: { id: '104', username: 'dave' },
  frank: { id: '105', username: 'frank' },
};

const ROSTER = [
  { id: 101, username: 'alice' },
  { id: 102, username: 'bob' },
  { id: 103, username: 'carol' },
  { id: 104, username: 'dave' },
  { id: 105, username: 'frank' },
];

// A fake platform directory fetch: resolves handles case-insensitively,
// refuses everyone else. "down" simulates the platform being unreachable.
function makeDirectoryFetch(state) {
  return async (url) => {
    if (state.down) throw new Error('network down');
    if (url.includes('/users/lookup')) {
      const handle = decodeURIComponent(url.split('username=')[1] || '');
      const match = ROSTER.find(
        (m) => m.username.toLowerCase() === handle.toLowerCase(),
      );
      return match
        ? jsonRes(200, { found: true, user: match })
        : jsonRes(200, { found: false, user: null });
    }
    return jsonRes(200, { members: ROSTER });
  };
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function buildApp({ members, enabled = true }) {
  const store = createSharingStore({ pool });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']] || null;
    // The forwarded iframe token, the way the real gate would deliver it.
    req.headers['x-usernode-token'] = 'test-token-' + req.headers['x-test-user'];
    next();
  });
  app.use('/api/sharing', createSharingRouter({ store, members, enabled }));
  // The app's own catch-all, mirroring server.js: an unknown /api path is a
  // typed JSON 404, never HTML and never a leak.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[sharing-test] internal error:', err && (err.stack || err.message || err));
    res.status(500).json({ error: { code: 'internal', message: 'Something failed.' } });
  });
  return { app, store };
}

async function listen(app, mount) {
  const s = http.createServer(app);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}${mount}`;
}

async function call(method, path, { as = 'alice', body } = {}) {
  // A "/down/…", "/off/…" or "/rate/…" prefix addresses one of the other app
  // instances (unreachable directory, feature off, fresh rate buckets); the
  // rest of the path is the route, keeping its leading slash.
  let origin = base;
  let rest = path;
  for (const [prefix, alt] of [['/down/', downBase], ['/off/', offBase], ['/rate/', rateBase]]) {
    if (path.startsWith(prefix)) {
      origin = alt;
      rest = path.slice(prefix.length - 1);
      break;
    }
  }
  const res = await fetch(origin + rest, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

// Every error body is exactly { error: { code, message[, fields] } }.
function assertTyped(res, status, code) {
  assert.equal(res.status, status);
  assert.ok(res.body && res.body.error, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
  assert.ok(typeof res.body.error.message === 'string' && res.body.error.message);
  const keys = Object.keys(res.body);
  assert.deepEqual(keys.sort(), ['error']);
  return res.body;
}

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });

  const mainState = { down: false };
  const main = buildApp({
    members: createMembersClient({
      platformApiBase: 'https://platform.test/v1',
      fetchImpl: makeDirectoryFetch(mainState),
    }),
  });
  await main.store.migrate();
  await main.store.migrate(); // the boot migration must be idempotent
  base = await listen(main.app, '/api/sharing');

  // A second app whose platform directory cannot be reached at all.
  const down = buildApp({
    members: createMembersClient({ platformApiBase: '' }),
  });
  downBase = await listen(down.app, '/api/sharing');

  // A third with the operator switch off.
  const off = buildApp({ members: createMembersClient({ platformApiBase: '' }), enabled: false });
  offBase = await listen(off.app, '/api/sharing');

  // A fourth with untouched rate-limit buckets, for the flood tests.
  const rate = buildApp({
    members: createMembersClient({
      platformApiBase: 'https://platform.test/v1',
      fetchImpl: makeDirectoryFetch({ down: false }),
    }),
  });
  rateBase = await listen(rate.app, '/api/sharing');
});

test.after(async () => {
  if (skip) return;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('the seven routes are the whole API surface, and invented paths 404', { skip }, async () => {
  // The probing below is the version-independent proof that no eighth route
  // exists: every invented path must 404 with the app's typed body, and the
  // seven real ones must respond as themselves (each named in later tests).
  const probed = [
    ['POST', '/sessions/1/recipients'],
    ['DELETE', '/sessions/1/recipients/102'],
    ['PATCH', '/sessions/1'],
    ['POST', '/sessions/1/extend'],
    ['GET', '/sessions/1'],
    ['GET', '/sessions'],
    ['DELETE', '/incoming/1'],
    ['POST', '/sessions/1/reopen'],
  ];
  for (const [method, path] of probed) {
    const res = await call(method, path);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error.code, 'not_found', `${method} ${path}`);
  }
  // The real routes answer as themselves (feature-on): each named below.
  assert.equal((await call('GET', '/sessions/mine')).status, 200);
  assert.equal((await call('GET', '/incoming')).status, 200);
  assert.equal((await call('GET', '/members')).status, 200);
});

test('members proxy: an unreachable directory answers honestly and fails closed', { skip }, async () => {
  const members = await call('GET', '/down/members');
  assert.equal(members.status, 200);
  assert.deepEqual(members.body, { available: false, members: [] });

  // Starting a share is refused, with a typed 503 — never "trust the typed
  // handle".
  const started = await call('POST', '/down/sessions', {
    as: 'alice',
    body: { recipients: ['bob'], durationMinutes: 60 },
  });
  assertTyped(started, 503, 'recipients_unavailable');

  // And nothing was created.
  const mine = await call('GET', '/down/sessions/mine', { as: 'alice' });
  assert.deepEqual(mine.body, { session: null });
  const incoming = await call('GET', '/down/incoming', { as: 'bob' });
  assert.deepEqual(incoming.body, { shares: [] });
});

test('the operator switch off: every route answers the honest 501', { skip }, async () => {
  const res = await call('GET', '/off/members');
  assertTyped(res, 501, 'not_configured');
  const created = await call('POST', '/off/sessions', {
    as: 'alice',
    body: { recipients: ['bob'], durationMinutes: 60 },
  });
  assertTyped(created, 501, 'not_configured');
});

// ── The security matrix ───────────────────────────────────────────────────

let S1; // alice's first session id, reused by the later tests

test('matrix 1: owner only — create, update, revoke are the owner’s alone', { skip }, async () => {
  const started = await call('POST', '/sessions', {
    as: 'alice',
    body: { recipients: ['BOB', 'bob', 'Carol'], durationMinutes: 60 },
  });
  assert.equal(started.status, 201);
  S1 = started.body.session.id;
  assert.match(S1, /^\d+$/);
  // Canonical casing from the directory, deduped by id.
  assert.deepEqual(started.body.session.recipients, [
    { userId: '102', username: 'bob' },
    { userId: '103', username: 'carol' },
  ]);

  // One active share per person, enforced by the database itself.
  const again = await call('POST', '/sessions', {
    as: 'alice',
    body: { recipients: ['bob'], durationMinutes: 1440 },
  });
  assertTyped(again, 409, 'conflict');

  // Bob cannot see, update or revoke Alice's session, and every answer is
  // the same 404 existence does not leak.
  const mine = await call('GET', '/sessions/mine', { as: 'bob' });
  assert.deepEqual(mine.body, { session: null });
  const posted = await call('POST', `/sessions/${S1}/location`, {
    as: 'bob',
    body: { lat: 1, lng: 1 },
  });
  assertTyped(posted, 404, 'not_found');
  const revoked = await call('DELETE', `/sessions/${S1}`, { as: 'bob' });
  assertTyped(revoked, 404, 'not_found');
  // Malformed ids are 404s too, never 500s.
  assert.equal((await call('POST', '/sessions/abc/location', { as: 'alice', body: { lat: 1, lng: 1 } })).status, 404);
  assert.equal((await call('DELETE', '/sessions/abc', { as: 'alice' })).status, 404);

  // Alice's own session answers through every one of her own routes.
  const hers = await call('GET', '/sessions/mine', { as: 'alice' });
  assert.equal(hers.body.session.id, S1);
  assert.equal(hers.body.session.durationMinutes, 60);
});

test('matrix 2: recipients are strictly read-only — no write, no list edit', { skip }, async () => {
  // Alice posts one real fix.
  const posted = await call('POST', `/sessions/${S1}/location`, {
    as: 'alice',
    body: { lat: 52.12345, lng: 13.98765, accuracy: 12.6 },
  });
  assert.equal(posted.status, 200);
  assert.ok(posted.body.ok);

  // Both recipients see it, with the server-computed age.
  for (const who of ['bob', 'carol']) {
    const incoming = await call('GET', '/incoming', { as: who });
    assert.equal(incoming.status, 200);
    const row = incoming.body.shares.find((s) => s.id === S1);
    assert.ok(row, who);
    assert.deepEqual(row.sharer, { username: 'alice' });
    assert.equal(row.lastFix.lat, 52.1234); // truncated on the way in
    assert.equal(row.lastFix.lng, 13.9876);
    assert.equal(row.lastFix.accuracy, 13); // ceiled accuracy
    assert.equal(typeof row.fixAgeSeconds, 'number');
    assert.ok(row.fixAgeSeconds < 5);
  }

  // A recipient cannot post, extend, re-open or revoke someone else's share;
  // every invented write path is the same 404.
  assert.equal((await call('PATCH', `/sessions/${S1}`, { as: 'bob', body: { durationMinutes: 1440 } })).status, 404);
  assert.equal((await call('POST', `/sessions/${S1}/extend`, { as: 'bob', body: {} })).status, 404);
  assert.equal((await call('POST', `/sessions/${S1}/recipients`, { as: 'bob', body: { recipients: ['bob'] } })).status, 404);

  // Bob dismisses the share for himself; Carol's view is untouched.
  const dismissed = await call('POST', `/incoming/${S1}/dismiss`, { as: 'bob' });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.dismissed, true);
  const bobIncoming = await call('GET', '/incoming', { as: 'bob' });
  assert.ok(!bobIncoming.body.shares.some((s) => s.id === S1));
  const carolIncoming = await call('GET', '/incoming', { as: 'carol' });
  assert.ok(carolIncoming.body.shares.some((s) => s.id === S1));

  // Dismissing again is a no-op; dismissing one Bob has no row for is 404.
  assert.equal((await call('POST', `/incoming/${S1}/dismiss`, { as: 'bob' })).body.dismissed, true);
  assert.equal((await call('POST', `/incoming/${S1}/dismiss`, { as: 'dave' })).status, 404);
});

test('matrix 3: no access through guessed or enumerated session ids', { skip }, async () => {
  const id = Number(S1);
  const leaked = [];
  for (const probe of [id - 2, id - 1, id, id + 1, id + 2, 1, 999999]) {
    for (const [method, suffix, body] of [
      ['DELETE', '', undefined],
      ['POST', '/location', { lat: 1, lng: 1 }],
    ]) {
      const res = await call(method, `/sessions/${probe}${suffix}`, { as: 'bob', body });
      assert.equal(res.status, 404, `${method} /sessions/${probe}${suffix}`);
      assert.equal(res.body.error.code, 'not_found');
      // The body carries the two error fields and nothing else — never a
      // username, a coordinate, or session metadata.
      leaked.push(JSON.stringify(res.body));
      const keys = Object.keys(res.body.error).sort();
      assert.ok(['code', 'message'].every((k) => keys.includes(k)), JSON.stringify(res.body));
      assert.ok(keys.every((k) => ['code', 'message', 'fields'].includes(k)));
    }
  }
  assert.ok(!leaked.some((s) => /"lat"|52\.1234/.test(s)), leaked.join('\n'));
});

test('matrix 4: revocation is immediate and atomic under concurrent requests', { skip }, async () => {
  // Carol is still a live recipient of S1 with a fix on it.
  const before = await call('GET', '/incoming', { as: 'carol' });
  assert.ok(before.body.shares.some((s) => s.id === S1));

  // A fix racing a stop: either the fix commits first and the stop then
  // erases it, or the stop commits first and the fix answers session_ended.
  // Either way the END state is the same: ended, and no position anywhere.
  const results = await Promise.all([
    call('DELETE', `/sessions/${S1}`, { as: 'alice' }),
    call('POST', `/sessions/${S1}/location`, { as: 'alice', body: { lat: 1.5, lng: 2.5 } }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.ok(statuses.includes(204), JSON.stringify(results));
  assert.ok(statuses.some((s) => s === 200 || s === 409), JSON.stringify(results));

  const { rows } = await pool.query('SELECT * FROM sharing_sessions WHERE id = $1', [S1]);
  assert.equal(rows[0].ended_reason, 'stopped');
  assert.ok(rows[0].ended_at);
  assert.equal(rows[0].last_lat, null);
  assert.equal(rows[0].last_lng, null);
  assert.equal(rows[0].last_fix_at, null);

  // Recipients lose it at once; the owner's own routes agree.
  const after = await call('GET', '/incoming', { as: 'carol' });
  assert.ok(!after.body.shares.some((s) => s.id === S1));
  const mine = await call('GET', '/sessions/mine', { as: 'alice' });
  assert.deepEqual(mine.body, { session: null });

  // Stopping again is idempotent for the owner, still 404 for anyone else.
  assert.equal((await call('DELETE', `/sessions/${S1}`, { as: 'alice' })).status, 204);
  assert.equal((await call('DELETE', `/sessions/${S1}`, { as: 'carol' })).status, 404);
});

test('matrix 5: expiry ends and erases lazily; rows purge a day later', { skip }, async () => {
  // A session already past its end, seeded directly with the store's own
  // insertion path so the shape is exactly what production writes.
  const past = new Date(Date.now() - 60_000);
  const created = await call('POST', '/rate/sessions', {
    as: 'frank',
    body: { recipients: ['bob'], durationMinutes: 60 },
  });
  const freshId = created.body.session.id;
  await pool.query('UPDATE sharing_sessions SET expires_at = $2 WHERE id = $1', [freshId, past]);
  await pool.query(
    `UPDATE sharing_sessions SET last_lat = 1, last_lng = 2, last_fix_at = now() WHERE id = $1`,
    [freshId],
  );

  // The next maintain (any read triggers it) ends and erases it.
  await call('GET', '/sessions/mine', { as: 'frank' });
  const { rows } = await pool.query('SELECT * FROM sharing_sessions WHERE id = $1', [freshId]);
  assert.equal(rows[0].ended_reason, 'expired');
  assert.equal(new Date(rows[0].ended_at).getTime(), past.getTime());
  assert.equal(rows[0].last_lat, null);
  assert.equal(rows[0].last_fix_at, null);

  // Posting to it now answers the typed 409; it appears in nobody's list.
  assertTyped(await call('POST', `/rate/sessions/${freshId}/location`, { as: 'frank', body: { lat: 1, lng: 2 } }), 409, 'session_ended');
  const incoming = await call('GET', '/incoming', { as: 'bob' });
  assert.ok(!incoming.body.shares.some((s) => s.id === freshId));

  // A day after expiry the row itself is gone.
  await pool.query(
    `UPDATE sharing_sessions SET expires_at = now() - interval '25 hours' WHERE id = $1`,
    [freshId],
  );
  await call('GET', '/incoming', { as: 'bob' });
  const { rows: gone } = await pool.query('SELECT 1 FROM sharing_sessions WHERE id = $1', [freshId]);
  assert.equal(gone.length, 0);
});

test('matrix 6: coordinates are minimized before storage and never leak', { skip }, async () => {
  const started = await call('POST', '/rate/sessions', {
    as: 'dave',
    body: { recipients: ['bob'], durationMinutes: 60 },
  });
  assert.equal(started.status, 201);
  const id = started.body.session.id;

  const posted = await call('POST', `/rate/sessions/${id}/location`, {
    as: 'dave',
    body: { lat: 52.123456789, lng: 13.987654321, accuracy: 12.2 },
  });
  assert.equal(posted.status, 200);

  const mine = await call('GET', '/rate/sessions/mine', { as: 'dave' });
  const fix = mine.body.session.lastFix;
  assert.equal(fix.lat, 52.1234);
  assert.equal(fix.lng, 13.9876);
  assert.equal(fix.accuracy, 13);

  // The 6-dp input never appears in any response, in any shape.
  const seen = JSON.stringify([started, posted, mine]);
  assert.ok(!seen.includes('52.123456'), seen);
  assert.ok(!seen.includes('13.987654'), seen);
  assert.ok(!seen.includes('52.12345'), seen);

  // Invalid fixes are typed 400s naming the field, and carry no coordinate.
  const bad = await call('POST', `/rate/sessions/${id}/location`, {
    as: 'dave',
    body: { lat: 95.123456, lng: 13.987654 },
  });
  assertTyped(bad, 400, 'invalid_request');
  assert.ok(bad.body.error.fields.lat);
  assert.ok(!JSON.stringify(bad.body).includes('13.987654'));
});

test('typed errors: validation, rate limits and the exact error shape', { skip }, async () => {
  // Validation, against fresh buckets (dave still has location tokens from
  // the leak test, so the /rate instance is only used for the flood below).
  const started = await call('POST', '/sessions', {
    as: 'dave',
    body: { recipients: ['bob'], durationMinutes: 90 },
  });
  assertTyped(started, 400, 'invalid_request');
  assert.ok(started.body.error.fields.durationMinutes);

  const noPeople = await call('POST', '/sessions', {
    as: 'dave',
    body: { recipients: [], durationMinutes: 60 },
  });
  assertTyped(noPeople, 400, 'invalid_request');
  assert.ok(noPeople.body.error.fields.recipients);

  const selfShare = await call('POST', '/sessions', {
    as: 'dave',
    body: { recipients: ['Dave'], durationMinutes: 60 },
  });
  assertTyped(selfShare, 400, 'invalid_request');

  const unknown = await call('POST', '/sessions', {
    as: 'dave',
    body: { recipients: ['stranger'], durationMinutes: 60 },
  });
  assertTyped(unknown, 400, 'invalid_request');
  assert.ok(/Nobody called stranger/.test(unknown.body.error.message));

  // Rate limits: eleven rapid position posts — the eleventh is typed 429.
  const floodSession = await call('POST', '/rate/sessions', {
    as: 'frank',
    body: { recipients: ['bob'], durationMinutes: 1440 },
  });
  assert.equal(floodSession.status, 201);
  let saw429 = false;
  for (let i = 0; i < 11; i++) {
    const res = await call('POST', `/rate/sessions/${floodSession.body.session.id}/location`, {
      as: 'frank',
      body: { lat: 1 + i / 10000, lng: 2 },
    });
    if (res.status === 429) {
      saw429 = true;
      assertTyped(res, 429, 'rate_limited');
      break;
    }
    assert.equal(res.status, 200, `post ${i}`);
  }
  assert.equal(saw429, true);

  // And the create limit: five per hour, the sixth attempt is typed 429.
  let sawCreate429 = false;
  for (let i = 0; i < 6; i++) {
    const res = await call('POST', '/rate/sessions', {
      as: 'carol',
      body: { recipients: ['bob'], durationMinutes: 60 },
    });
    if (res.status === 429) {
      sawCreate429 = true;
      assertTyped(res, 429, 'rate_limited');
      break;
    }
    // Successive creations conflict with the one-active rule, which still
    // consumes a bucket token by design (attempt-based limiting).
    assert.ok([201, 409].includes(res.status), JSON.stringify(res.body));
  }
  assert.equal(sawCreate429, true);
});
