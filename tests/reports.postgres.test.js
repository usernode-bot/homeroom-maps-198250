// Reports store and routes against a REAL Postgres database.
//
// Each run creates its own throwaway schema, applies the boot migration and
// drives the actual HTTP routes (reports/routes.js over reports/store.js)
// with an express app whose only stand-in is the identity: a header names
// the signed-in person, as the platform token would. Nothing in the code
// under test is stubbed.
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL (the build
// worker's local Postgres). Skipped, loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createPolicies } = require('../community/policies');
const { createReportsStore } = require('../reports/store');
const { createReportsRouter } = require('../reports/routes');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;

const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let base;
let policies;
const schema = `reports_test_${process.pid}_${Date.now()}`;

async function call(method, path, { as = 'alice', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const USERS = {
  alice: { id: 201, username: 'alice' },
  bob: { id: 202, username: 'bob' },
  carol: { id: 203, username: 'carol' },
  rita: { id: 204, username: 'Rita' }, // a reviewer, matched case-insensitively
};

function report(overrides = {}) {
  return {
    type: 'flood',
    lat: 52.52,
    lng: 13.4,
    description: 'Water is over the kerb on the north side.',
    ...overrides,
  };
}

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  policies = createPolicies();
  const store = createReportsStore({ pool, policies });
  await store.migrate();
  await store.migrate(); // the boot migration must be idempotent
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']];
    next();
  });
  app.use('/api/reports', createReportsRouter({ store, reviewers: new Set(['rita']) }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/reports`;
});

test.after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('meta names the types, statuses and the viewer role', { skip }, async () => {
  const r = await call('GET', '/meta', { as: 'rita' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.types.map((t) => t.id),
    ['traffic', 'accident', 'road_closed', 'construction', 'hazard', 'flood', 'fire', 'broken_road', 'wrong_map_data', 'place_closed', 'other'],
  );
  assert.deepEqual(r.body.statuses.map((s) => s.id), ['pending', 'verified', 'rejected']);
  assert.deepEqual(r.body.views, ['recent', 'nearby', 'mine']);
  assert.equal(r.body.viewer.reviewer, true);
  const plain = await call('GET', '/meta', { as: 'bob' });
  assert.equal(plain.body.viewer.reviewer, false);
});

test('empty feed: every view answers an empty list, not an error', { skip }, async () => {
  for (const view of ['recent', 'mine']) {
    const r = await call('GET', `/?view=${view}`, { as: 'carol' });
    assert.equal(r.status, 200, view);
    assert.deepEqual(r.body.items, [], view);
    assert.equal(r.body.hasMore, false);
  }
  const near = await call('GET', '/?view=nearby&near=52.5,13.4', { as: 'carol' });
  assert.equal(near.status, 200);
  assert.deepEqual(near.body.items, []);
});

test('nearby without a location is a 400, not an empty feed', { skip }, async () => {
  const r = await call('GET', '/?view=nearby', { as: 'bob' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_query');
});

test('create: validation errors name each field and carry the typed codes', { skip }, async () => {
  const r = await call('POST', '/', { body: { type: 'nope', lat: 1, lng: 2 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_report_type');
  assert.ok(r.body.error.fields.type);

  const badCoords = await call('POST', '/', { body: report({ lat: 100 }) });
  assert.equal(badCoords.status, 400);
  assert.equal(badCoords.body.error.code, 'invalid_coordinates');
  assert.ok(badCoords.body.error.fields.location);

  const long = await call('POST', '/', { body: report({ description: 'x'.repeat(2001) }) });
  assert.equal(long.status, 400);
  assert.ok(long.body.error.fields.description);

  const place = await call('POST', '/', { body: report({ placeId: 'only-id' }) });
  assert.equal(place.status, 400);
  assert.ok(place.body.error.fields.placeId);
});

test('create a report: immediately public, with a derived expiry and history', { skip }, async () => {
  const created = await call('POST', '/', {
    as: 'alice',
    body: report({ type: 'traffic', placeId: ' p-9 ', placeProvider: ' photon ' }),
  });
  assert.equal(created.status, 200);
  const p = created.body;
  assert.equal(p.status, 'pending');
  assert.equal(p.effectiveStatus, 'pending');
  assert.equal(p.type, 'traffic');
  assert.equal(p.typeLabel, 'Traffic');
  assert.equal(p.reporter.username, 'alice');
  assert.deepEqual(p.place, { id: 'p-9', provider: 'photon' });
  // The window comes from the type: traffic expires 3 hours out.
  const ageMs = new Date(p.expiresAt).getTime() - new Date(p.createdAt).getTime();
  assert.equal(ageMs, 3 * 3600 * 1000);
  assert.deepEqual(
    p.history.map((h) => [h.from, h.to, h.actor]),
    [[null, 'pending', 'alice']],
  );
  // The reporter cannot react to or flag their own report.
  assert.equal(p.viewer.isReporter, true);
  assert.equal(p.viewer.canReact, false);
  assert.equal(p.viewer.reaction, null);
  assert.match(p.viewer.reactBlockedReason, /own report/);
  assert.deepEqual(p.viewer.transitions, []);

  // Another person sees it in Recent and Nearby, and may react.
  const recent = await call('GET', '/?view=recent', { as: 'bob' });
  assert.ok(recent.body.items.some((x) => x.id === p.id));
  const near = await call('GET', '/?view=nearby&near=52.52,13.40&radius=10', { as: 'bob' });
  assert.equal(near.body.items[0].id, p.id);
  assert.ok(near.body.items[0].distanceKm < 10);
  const other = await call('GET', `/${p.id}`, { as: 'bob' });
  assert.equal(other.body.viewer.canReact, true);
  assert.equal(other.body.viewer.isReporter, false);

  // Malformed place references never reach the database shape-check twice.
  const noPlace = await call('POST', '/', { as: 'bob', body: report({ type: 'fire' }) });
  assert.equal(noPlace.status, 200);
  assert.equal(noPlace.body.place, null);
});

test('reactions: one active answer per person, changes, duplicates, withdrawal', { skip }, async () => {
  const p = (await call('POST', '/', { as: 'carol', body: report({ type: 'hazard' }) })).body;

  // The reporter cannot react.
  const own = await call('PUT', `/${p.id}/reaction`, { as: 'carol', body: { value: 'confirm' } });
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'reaction_not_allowed');

  const bad = await call('PUT', `/${p.id}/reaction`, { as: 'bob', body: { value: 'maybe' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_reaction');

  const up = await call('PUT', `/${p.id}/reaction`, { as: 'bob', body: { value: 'confirm' } });
  assert.equal(up.body.outcome, 'cast');
  assert.deepEqual(up.body.report.reactions, { confirm: 1, disagree: 0 });
  assert.equal(up.body.report.viewer.reaction, 'confirm');

  // The same answer again, including in parallel, never counts twice.
  const repeats = await Promise.all(
    [1, 2, 3].map(() => call('PUT', `/${p.id}/reaction`, { as: 'bob', body: { value: 'confirm' } })),
  );
  for (const r of repeats) assert.equal(r.body.outcome, 'unchanged');
  const afterRepeat = await call('GET', `/${p.id}`, { as: 'carol' });
  assert.deepEqual(afterRepeat.body.reactions, { confirm: 1, disagree: 0 });
  const rows = await pool.query('SELECT count(*)::int AS n FROM report_reactions WHERE report_id = $1', [p.id]);
  assert.equal(rows.rows[0].n, 1);

  // Changing the answer moves it, it does not add a second one.
  const down = await call('PUT', `/${p.id}/reaction`, { as: 'bob', body: { value: 'disagree' } });
  assert.equal(down.body.outcome, 'changed');
  assert.deepEqual(down.body.report.reactions, { confirm: 0, disagree: 1 });

  // Simultaneous first answers from different people are each counted once.
  await Promise.all([
    call('PUT', `/${p.id}/reaction`, { as: 'alice', body: { value: 'confirm' } }),
    call('PUT', `/${p.id}/reaction`, { as: 'rita', body: { value: 'confirm' } }),
  ]);
  const tally = (await call('GET', `/${p.id}`, { as: 'bob' })).body;
  // Bob's own answer is the Disagree he changed to; Alice and Rita Confirmed.
  assert.deepEqual(tally.reactions, { confirm: 2, disagree: 1 });
  assert.equal(tally.viewer.reaction, 'disagree');

  // Withdrawing removes the row; withdrawing again is a no-op.
  const removed = await call('DELETE', `/${p.id}/reaction`, { as: 'bob' });
  assert.equal(removed.body.outcome, 'removed');
  assert.deepEqual(removed.body.report.reactions, { confirm: 2, disagree: 0 });
  assert.equal(removed.body.report.viewer.reaction, null);
  const again = await call('DELETE', `/${p.id}/reaction`, { as: 'bob' });
  assert.equal(again.body.outcome, 'unchanged');
});

test('flags: once per person, never by the reporter, listeners hear it once', { skip }, async () => {
  const heard = [];
  policies.on('report.flagged', ({ report: r, viewer }) => heard.push([r.id, viewer.username]));

  const p = (await call('POST', '/', { as: 'alice', body: report({ type: 'other' }) })).body;
  const own = await call('POST', `/${p.id}/flag`, { as: 'alice', body: { reason: 'mine' } });
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'flag_not_allowed');

  const tooLong = await call('POST', `/${p.id}/flag`, { as: 'bob', body: { reason: 'x'.repeat(501) } });
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.body.error.fields.reason);

  const flagged = await call('POST', `/${p.id}/flag`, { as: 'bob', body: { reason: 'Looks staged.' } });
  assert.equal(flagged.status, 200);
  assert.equal(flagged.body.outcome, 'flagged');

  // A second flag by the same person is a no-op, not a second row.
  const again = await call('POST', `/${p.id}/flag`, { as: 'bob' });
  assert.equal(again.body.outcome, 'already');
  const rows = await pool.query('SELECT count(*)::int AS n FROM report_flags WHERE report_id = $1', [p.id]);
  assert.equal(rows.rows[0].n, 1);
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0][0], p.id);
  assert.equal(heard[0][1], 'bob');

  // A different person can still flag.
  const carol = await call('POST', `/${p.id}/flag`, { as: 'carol', body: {} });
  assert.equal(carol.body.outcome, 'flagged');
});

test('status transitions follow the lifecycle and the roles', { skip }, async () => {
  const p = (await call('POST', '/', { as: 'alice', body: report({ type: 'road_closed' }) })).body;
  const move = (as, status) => call('POST', `/${p.id}/status`, { as, body: { status } });

  // Reviewers only; nobody skips a step; unknown statuses are 400s.
  assert.equal((await move('alice', 'verified')).status, 403);
  assert.equal((await move('bob', 'verified')).status, 403);
  assert.equal((await move('rita', 'bogus')).status, 400);
  // A pending report may go straight to Rejected; it cannot stay Pending.
  assert.equal((await move('rita', 'pending')).status, 409);

  const verified = await move('rita', 'verified');
  assert.equal(verified.body.status, 'verified');
  assert.deepEqual(verified.body.viewer.transitions, ['rejected']);
  assert.deepEqual(
    verified.body.history.map((h) => h.to),
    ['pending', 'verified'],
  );
  // Reactions stay open while it is reviewed — only the reporter is excluded.
  assert.equal((await call('PUT', `/${p.id}/reaction`, { as: 'bob', body: { value: 'confirm' } })).status, 200);

  const rejected = await move('rita', 'rejected');
  assert.equal(rejected.body.status, 'rejected');
  assert.equal(rejected.body.effectiveStatus, 'rejected');
  assert.deepEqual(rejected.body.viewer.transitions, []);
  assert.equal((await move('rita', 'pending')).status, 409);
  assert.deepEqual(
    rejected.body.history.map((h) => [h.from, h.to]),
    [[null, 'pending'], ['pending', 'verified'], ['verified', 'rejected']],
  );
});

test('expiration is derived on read: stale reports read Expired and leave the feed', { skip }, async () => {
  const p = (await call('POST', '/', { as: 'alice', body: report({ type: 'fire' }) })).body;
  assert.equal(p.effectiveStatus, 'pending');

  // Push its expiry into the past directly; nothing ever stores 'expired'.
  await pool.query("UPDATE reports SET expires_at = now() - interval '1 hour' WHERE id = $1", [p.id]);

  const got = await call('GET', `/${p.id}`, { as: 'bob' });
  assert.equal(got.body.status, 'pending');
  assert.equal(got.body.effectiveStatus, 'expired');

  const recent = await call('GET', '/?view=recent', { as: 'bob' });
  assert.ok(!recent.body.items.some((x) => x.id === p.id), 'expired reports leave Recent');
  const near = await call('GET', '/?view=nearby&near=52.52,13.40&radius=100', { as: 'bob' });
  assert.ok(!near.body.items.some((x) => x.id === p.id), 'expired reports leave Nearby');
  const withHistory = await call('GET', '/?view=recent&includeExpired=1', { as: 'bob' });
  assert.ok(withHistory.body.items.some((x) => x.id === p.id), 'includeExpired shows the history');

  // The reporter still sees it in Mine (their own history).
  const mine = await call('GET', '/?view=mine', { as: 'alice' });
  const row = mine.body.items.find((x) => x.id === p.id);
  assert.ok(row, 'Mine keeps the reporter’s expired report');
  assert.equal(row.effectiveStatus, 'expired');

  // A reviewer can still act on a stale report; the pill derives live.
  const moved = await call('POST', `/${p.id}/status`, { as: 'rita', body: { status: 'verified' } });
  assert.equal(moved.body.effectiveStatus, 'expired');
  const rejected = await call('POST', `/${p.id}/status`, { as: 'rita', body: { status: 'rejected' } });
  assert.equal(rejected.body.effectiveStatus, 'rejected');
  assert.ok(
    (await call('GET', '/?view=recent', { as: 'bob' })).body.items.some((x) => x.id === p.id),
    'a rejected report keeps its standing answer in the feed',
  );
});

test('paging reports hasMore and the next offset', { skip }, async () => {
  const first = (await call('GET', '/?view=recent&limit=2', { as: 'bob' })).body;
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  const second = (await call('GET', `/?view=recent&limit=2&offset=${first.nextOffset}`, { as: 'bob' })).body;
  assert.ok(!second.items.some((x) => first.items.some((y) => y.id === x.id)));
});

test('type and place filters narrow the feed', { skip }, async () => {
  const fire = (await call('POST', '/', { as: 'carol', body: report({ type: 'fire', lat: 48.85, lng: 2.35 }) })).body;
  const typed = (await call('GET', '/?view=recent&type=fire', { as: 'bob' })).body.items;
  assert.ok(typed.length >= 1);
  assert.ok(typed.every((x) => x.type === 'fire'));
  assert.ok(typed.some((x) => x.id === fire.id));
  const placed = (await call('GET', '/?view=recent&placeId=p-9', { as: 'bob' })).body.items;
  assert.equal(placed.length, 1);
  assert.equal(placed[0].place.id, 'p-9');
  const bad = await call('GET', '/?view=recent&type=bogus', { as: 'bob' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_report_type');
});

test('unknown and malformed ids are 404s', { skip }, async () => {
  assert.equal((await call('GET', '/999999999', { as: 'bob' })).status, 404);
  assert.equal((await call('GET', '/abc', { as: 'bob' })).status, 404);
  assert.equal((await call('PUT', '/abc/reaction', { as: 'bob', body: { value: 'confirm' } })).status, 404);
  assert.equal((await call('POST', '/abc/flag', { as: 'bob', body: {} })).status, 404);
  assert.equal((await call('POST', '/abc/status', { as: 'rita', body: { status: 'verified' } })).status, 404);
});

test('staging seed is idempotent and never involves the visitor', { skip }, async () => {
  const store = createReportsStore({ pool, policies: createPolicies() });
  await store.seedStaging();
  await store.seedStaging();
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM reports WHERE id BETWEEN 920001 AND 920099');
  assert.equal(rows[0].n, 5);
  // Every seeded report, reaction and flag belongs to a demo identity.
  const strangers = await pool.query(
    "SELECT count(*)::int AS n FROM reports WHERE id >= 920001 AND reporter_id NOT LIKE 'staging-demo-%'",
  );
  assert.equal(strangers.rows[0].n, 0);
  const votes = await pool.query(
    "SELECT count(*)::int AS n FROM report_reactions WHERE report_id >= 920001 AND user_id NOT LIKE 'staging-demo-%'",
  );
  assert.equal(votes.rows[0].n, 0);
  // The verified demo report carries the spec's reaction split.
  const demo = (await call('GET', '/920002', { as: 'carol' })).body;
  assert.deepEqual(demo.reactions, { confirm: 3, disagree: 1 });
  assert.deepEqual(
    demo.history.map((h) => h.to),
    ['pending', 'verified'],
  );
  // One seeded report is already past its expiry.
  const expired = (await call('GET', '/920004', { as: 'carol' })).body;
  assert.equal(expired.effectiveStatus, 'expired');
  // A fresh visitor's own list is untouched by the seed.
  const mine = (await call('GET', '/?view=mine', { as: 'carol' })).body.items;
  assert.ok(mine.every((x) => x.reporter.username === 'carol'));
});