// Reputation store and its policy listeners against a REAL Postgres database.
//
// Wired exactly as server.js wires it: one shared policies registry passed to
// the proposal store and the report store, the reputation store registered on
// it, real HTTP routes driven with an express app whose only stand-in is the
// identity (a header names the signed-in person, as the platform token
// would). Nothing in the code under test is stubbed — the awards under test
// are the ones the real stores emit after their transactions commit.
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
const { createStore } = require('../community/store');
const { createCommunityRouter } = require('../community/routes');
const { createReportsStore } = require('../reports/store');
const { createReportsRouter } = require('../reports/routes');
const { createReputationStore } = require('../community/reputation-store');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;

const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let communityBase;
let reportsBase;
let policies;
let reputationStore;
const schema = `reputation_test_${process.pid}_${Date.now()}`;

async function call(base, method, path, { as = 'alice', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const USERS = {
  alice: { id: 301, username: 'alice' },
  bob: { id: 302, username: 'bob' },
  carol: { id: 303, username: 'carol' },
  dan: { id: 304, username: 'dan' },
  rita: { id: 305, username: 'Rita' }, // a reviewer, matched case-insensitively
};

function draft(overrides = {}) {
  return {
    title: 'Add the corner bakery',
    description: 'A bakery opened on this corner last year and is missing.',
    category: 'add_missing_place',
    location: { name: 'Kastanienallee, Berlin', lat: 52.5386, lng: 13.4108 },
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
  const communityStore = createStore({ pool, policies, platformOrigin: 'https://platform.test' });
  const reportsStore = createReportsStore({ pool, policies });
  reputationStore = createReputationStore({ pool });
  reputationStore.register(policies);
  await communityStore.migrate();
  await reportsStore.migrate();
  await reputationStore.migrate();
  // The boot migration must be idempotent.
  await communityStore.migrate();
  await reportsStore.migrate();
  await reputationStore.migrate();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']];
    next();
  });
  app.use('/api/community', createCommunityRouter({ store: communityStore, reviewers: new Set(['rita']) }));
  app.use('/api/reports', createReportsRouter({ store: reportsStore, reviewers: new Set(['rita']) }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  communityBase = `http://127.0.0.1:${server.address().port}/api/community`;
  reportsBase = `http://127.0.0.1:${server.address().port}/api/reports`;
});

test.after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('a draft create earns nothing; publishing the draft awards +2 exactly once', { skip }, async () => {
  assert.deepEqual(await reputationStore.totalFor('301'), { total: 0, level: 'new' });

  const created = await call(communityBase, 'POST', '/proposals', { body: draft() });
  assert.equal(created.status, 200);
  assert.equal(created.body.status, 'draft');
  assert.deepEqual(await reputationStore.totalFor('301'), { total: 0, level: 'new' });

  const published = await call(communityBase, 'POST', `/proposals/${created.body.id}/status`, {
    body: { status: 'open' },
  });
  assert.equal(published.status, 200);
  assert.deepEqual(await reputationStore.totalFor('301'), { total: 2, level: 'new' });

  // A redelivered event — the same listener payload again — is absorbed by
  // the ledger's unique key, and five parallel copies leave one row.
  const again = await reputationStore.award({
    userId: '301',
    eventType: 'proposal_published',
    targetId: created.body.id,
  });
  assert.equal(again.awarded, false);
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () =>
      reputationStore.award({ userId: '301', eventType: 'proposal_published', targetId: created.body.id })),
  );
  assert.equal(parallel.filter((r) => r.awarded).length, 0);
  assert.deepEqual(await reputationStore.totalFor('301'), { total: 2, level: 'new' });

  // The stored row carries the catalog's points, decided server-side.
  const { rows } = await pool.query(
    `SELECT points, event_type, target_type, target_id FROM reputation_events
      WHERE user_id = $1 AND event_type = 'proposal_published'`,
    ['301'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].points, 2);
  assert.equal(rows[0].target_type, 'proposal');
  assert.equal(String(rows[0].target_id), created.body.id);
});

test('publish-at-create awards once, and a reopen/re-accept loop never double-awards', { skip }, async () => {
  const p = (await call(communityBase, 'POST', '/proposals', { as: 'bob', body: { ...draft(), publish: true } })).body;
  assert.equal(p.status, 'open');
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 2, level: 'new' });

  const move = (status) => call(communityBase, 'POST', `/proposals/${p.id}/status`, { as: 'rita', body: { status } });
  assert.equal((await move('under_review')).status, 200);
  assert.equal((await move('accepted')).status, 200);
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 7, level: 'new' });
  assert.equal((await move('implemented')).status, 200);
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 12, level: 'contributor' });

  // A second proposal exercises the reopen path: publish-at-create awards
  // +2 again (total 14), under_review → open is not a publish and earns
  // nothing, and a later accept still awards exactly once.
  const q = (await call(communityBase, 'POST', '/proposals', { as: 'bob', body: { ...draft({ title: 'A second proposal' }), publish: true } })).body;
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 14, level: 'contributor' });
  const qMove = (status) => call(communityBase, 'POST', `/proposals/${q.id}/status`, { as: 'rita', body: { status } });
  assert.equal((await qMove('under_review')).status, 200);
  assert.equal((await qMove('open')).status, 200);
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 14, level: 'contributor' });
  assert.equal((await qMove('under_review')).status, 200);
  assert.equal((await qMove('accepted')).status, 200);
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 19, level: 'contributor' });

  // The lifecycle itself already refuses a second accept…
  assert.equal((await qMove('accepted')).status, 409);
  // …and even a redelivered accepted event is absorbed by the unique key.
  const redelivered = await reputationStore.award({
    userId: '302',
    eventType: 'proposal_accepted',
    targetId: q.id,
  });
  assert.equal(redelivered.awarded, false);
  assert.deepEqual(await reputationStore.totalFor('302'), { total: 19, level: 'contributor' });

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM reputation_events
      WHERE user_id = '302' AND event_type = 'proposal_accepted'`,
  );
  assert.equal(rows[0].n, 2); // one per accepted proposal, never more
});

test('a verified report earns +3 for the reporter; a rejected one earns nothing', { skip }, async () => {
  const good = (await call(reportsBase, 'POST', '/', { as: 'carol', body: { type: 'flood', lat: 52.52, lng: 13.4, description: 'Water over the kerb.' } })).body;
  const bad = (await call(reportsBase, 'POST', '/', { as: 'carol', body: { type: 'hazard', lat: 52.51, lng: 13.41, description: 'Loose slab.' } })).body;
  assert.deepEqual(await reputationStore.totalFor('303'), { total: 0, level: 'new' });

  assert.equal((await call(reportsBase, 'POST', `/${bad.id}/status`, { as: 'rita', body: { status: 'rejected' } })).status, 200);
  assert.deepEqual(await reputationStore.totalFor('303'), { total: 0, level: 'new' });

  assert.equal((await call(reportsBase, 'POST', `/${good.id}/status`, { as: 'rita', body: { status: 'verified' } })).status, 200);
  assert.deepEqual(await reputationStore.totalFor('303'), { total: 3, level: 'new' });

  // Re-verifying is impossible through the lifecycle, and a redelivered
  // event adds no row either.
  assert.equal((await call(reportsBase, 'POST', `/${good.id}/status`, { as: 'rita', body: { status: 'verified' } })).status, 409);
  const redelivered = await reputationStore.award({
    userId: '303',
    eventType: 'report_verified',
    targetId: good.id,
  });
  assert.equal(redelivered.awarded, false);
  assert.deepEqual(await reputationStore.totalFor('303'), { total: 3, level: 'new' });
});

test('votes and reactions never move reputation', { skip }, async () => {
  const p = (await call(communityBase, 'POST', '/proposals', { as: 'alice', body: { ...draft({ title: 'Vote on me' }), publish: true } })).body;
  const before = await reputationStore.totalFor('301');
  assert.equal((await call(communityBase, 'PUT', `/proposals/${p.id}/vote`, { as: 'dan', body: { value: 1 } })).status, 200);
  assert.equal((await call(communityBase, 'PUT', `/proposals/${p.id}/vote`, { as: 'rita', body: { value: -1 } })).status, 200);
  assert.deepEqual(await reputationStore.totalFor('301'), before);
  assert.deepEqual(await reputationStore.totalFor('304'), { total: 0, level: 'new' });
  assert.deepEqual(await reputationStore.totalFor('305'), { total: 0, level: 'new' });
});

test('award validates its inputs and refuses an unknown event or a missing target', { skip }, async () => {
  await assert.rejects(
    () => reputationStore.award({ userId: '301', eventType: 'vote_cast', targetId: '1' }),
    /Unknown reputation event/,
  );
  await assert.rejects(
    () => reputationStore.award({ userId: '301', eventType: 'proposal_published' }),
    /needs its proposal target id/,
  );
  await assert.rejects(
    () => reputationStore.award({ eventType: 'proposal_published', targetId: '1' }),
    /needs the user/,
  );
});

test('unrelated listeners are unaffected: gates still refuse and other events still fire', { skip }, async () => {
  const heard = [];
  policies.on('vote.cast', ({ value }) => heard.push(value));
  policies.registerGate('create', 'test-gate', ({ draft: d }) =>
    d.title.includes('BLOCKME') ? { code: 'possible_duplicate', message: 'Looks like a duplicate.', status: 409 } : null,
  );
  const refused = await call(communityBase, 'POST', '/proposals', { body: draft({ title: 'BLOCKME please' }) });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'possible_duplicate');
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM proposals WHERE title LIKE 'BLOCKME%'");
  assert.equal(rows[0].n, 0);

  const p = (await call(communityBase, 'POST', '/proposals', { as: 'dan', body: { ...draft({ title: 'Listener check' }), publish: true } })).body;
  await call(communityBase, 'PUT', `/proposals/${p.id}/vote`, { as: 'carol', body: { value: -1 } });
  assert.deepEqual(heard, [-1]);
  // The publish still earned its award through the same registry.
  assert.equal((await reputationStore.totalFor('304')).total, 2);
});
