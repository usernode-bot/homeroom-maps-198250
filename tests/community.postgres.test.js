// Community store and routes against a REAL Postgres database.
//
// Each run creates its own throwaway schema, applies the boot migration and
// drives the actual HTTP routes (community/routes.js over community/store.js)
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
const { createStore } = require('../community/store');
const { createCommunityRouter } = require('../community/routes');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const ORIGIN = 'https://platform.test';
const FILE = (n) => `${ORIGIN}/app-files/${String(n).repeat(32).slice(0, 32)}`;

const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let base;
let policies;
const schema = `community_test_${process.pid}_${Date.now()}`;

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
  const store = createStore({ pool, policies, platformOrigin: ORIGIN });
  await store.migrate();
  await store.migrate(); // the boot migration must be idempotent
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']];
    next();
  });
  app.use('/api/community', createCommunityRouter({ store, reviewers: new Set(['rita']) }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/community`;
});

test.after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('empty feed: every view answers an empty list, not an error', { skip }, async () => {
  for (const view of ['recent', 'popular', 'implemented', 'mine']) {
    const r = await call('GET', `/proposals?view=${view}`);
    assert.equal(r.status, 200, view);
    assert.deepEqual(r.body.items, [], view);
    assert.equal(r.body.hasMore, false);
  }
  const near = await call('GET', '/proposals?view=nearby&near=52.5,13.4');
  assert.equal(near.status, 200);
  assert.deepEqual(near.body.items, []);
});

test('nearby without a location is a 400, not an empty feed', { skip }, async () => {
  const r = await call('GET', '/proposals?view=nearby');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_query');
});

test('create: validation errors name each field', { skip }, async () => {
  const r = await call('POST', '/proposals', {
    body: { title: 'x', description: 'short', category: 'nope' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_proposal');
  assert.ok(r.body.error.fields.title);
  assert.ok(r.body.error.fields.description);
  assert.ok(r.body.error.fields.category);

  const noLoc = await call('POST', '/proposals', { body: draft({ location: null }) });
  assert.equal(noLoc.status, 400);
  assert.ok(noLoc.body.error.fields.location);

  const badFile = await call('POST', '/proposals', {
    body: draft({ attachments: [{ url: 'https://evil.test/app-files/' + 'a'.repeat(32) }] }),
  });
  assert.equal(badFile.status, 400);
  assert.ok(badFile.body.error.fields.attachments);
});

test('create a draft: visible only to its author, editable, then published', { skip }, async () => {
  const created = await call('POST', '/proposals', {
    body: draft({ attachments: [{ url: FILE('a'), contentType: 'image/jpeg', filename: 'shop.jpg' }] }),
  });
  assert.equal(created.status, 200);
  const p = created.body;
  assert.equal(p.status, 'draft');
  assert.equal(p.author.username, 'alice');
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].url, FILE('a'));
  assert.equal(p.publishedAt, null);
  assert.deepEqual(p.viewer.transitions, ['open']);
  assert.equal(p.viewer.canEdit, true);

  // Drafts are private to the author.
  assert.equal((await call('GET', `/proposals/${p.id}`, { as: 'bob' })).status, 404);
  const bobFeed = await call('GET', '/proposals?view=recent', { as: 'bob' });
  assert.ok(!bobFeed.body.items.some((x) => x.id === p.id));
  const mine = await call('GET', '/proposals?view=mine');
  assert.ok(mine.body.items.some((x) => x.id === p.id));

  // Another person cannot edit or publish it (it does not exist for them).
  assert.equal((await call('PATCH', `/proposals/${p.id}`, { as: 'bob', body: { title: 'Hijacked title' } })).status, 404);
  assert.equal((await call('POST', `/proposals/${p.id}/status`, { as: 'bob', body: { status: 'open' } })).status, 404);

  // The author edits freely while it is a draft; invalid edits are refused.
  const edited = await call('PATCH', `/proposals/${p.id}`, { body: { title: 'Add the corner bakery (Kastanienallee)' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, 'Add the corner bakery (Kastanienallee)');
  assert.equal(edited.body.description, p.description);
  assert.equal((await call('PATCH', `/proposals/${p.id}`, { body: { title: '' } })).status, 400);

  // Voting is closed on a draft.
  assert.equal((await call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: 1 } })).status, 404);

  const published = await call('POST', `/proposals/${p.id}/status`, { body: { status: 'open' } });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, 'open');
  assert.ok(published.body.publishedAt);
  assert.deepEqual(
    published.body.history.map((h) => [h.from, h.to, h.actor]),
    [[null, 'draft', 'alice'], ['draft', 'open', 'alice']],
  );
  const recent = await call('GET', '/proposals?view=recent', { as: 'bob' });
  assert.ok(recent.body.items.some((x) => x.id === p.id));
});

test('voting: one active vote per person, changes, duplicates and withdrawal', { skip }, async () => {
  const p = (await call('POST', '/proposals', { body: { ...draft(), publish: true } })).body;
  assert.equal(p.status, 'open');
  assert.deepEqual(p.votes, { up: 0, down: 0, score: 0 });

  // Authors cannot vote on their own proposal.
  const own = await call('PUT', `/proposals/${p.id}/vote`, { body: { value: 1 } });
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'vote_not_allowed');

  const bad = await call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: 2 } });
  assert.equal(bad.status, 400);

  const up = await call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: 1 } });
  assert.equal(up.body.outcome, 'cast');
  assert.deepEqual(up.body.proposal.votes, { up: 1, down: 0, score: 1 });
  assert.equal(up.body.proposal.viewer.vote, 1);

  // The same vote again, including in parallel, never counts twice.
  const repeats = await Promise.all(
    [1, 2, 3].map(() => call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: 1 } })),
  );
  for (const r of repeats) assert.equal(r.body.outcome, 'unchanged');
  const afterRepeat = await call('GET', `/proposals/${p.id}`, { as: 'carol' });
  assert.deepEqual(afterRepeat.body.votes, { up: 1, down: 0, score: 1 });
  assert.equal(afterRepeat.body.viewer.vote, 0);
  const rows = await pool.query('SELECT count(*)::int AS n FROM proposal_votes WHERE proposal_id = $1', [p.id]);
  assert.equal(rows.rows[0].n, 1);

  // Changing the vote moves it, it does not add a second one.
  const down = await call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: -1 } });
  assert.equal(down.body.outcome, 'changed');
  assert.deepEqual(down.body.proposal.votes, { up: 0, down: 1, score: -1 });

  // Simultaneous first votes from different people are each counted once.
  await Promise.all([
    call('PUT', `/proposals/${p.id}/vote`, { as: 'carol', body: { value: 1 } }),
    call('PUT', `/proposals/${p.id}/vote`, { as: 'rita', body: { value: 1 } }),
  ]);
  const tally = (await call('GET', `/proposals/${p.id}`, { as: 'bob' })).body;
  assert.deepEqual(tally.votes, { up: 2, down: 1, score: 1 });
  assert.equal(tally.viewer.vote, -1);

  // Edits stop once anyone has voted.
  const lockedEdit = await call('PATCH', `/proposals/${p.id}`, { body: { title: 'A different title now' } });
  assert.equal(lockedEdit.status, 409);
  assert.equal(lockedEdit.body.error.code, 'edit_not_allowed');

  // Withdrawing removes the row; withdrawing again is a no-op.
  const removed = await call('DELETE', `/proposals/${p.id}/vote`, { as: 'bob' });
  assert.equal(removed.body.outcome, 'removed');
  assert.deepEqual(removed.body.proposal.votes, { up: 2, down: 0, score: 2 });
  const again = await call('DELETE', `/proposals/${p.id}/vote`, { as: 'bob' });
  assert.equal(again.body.outcome, 'unchanged');
});

test('status transitions follow the lifecycle and the roles', { skip }, async () => {
  const p = (await call('POST', '/proposals', { body: { ...draft(), publish: true } })).body;
  const move = (as, status) => call('POST', `/proposals/${p.id}/status`, { as, body: { status } });

  // Authors cannot review their own proposal; nobody can skip a step.
  assert.equal((await move('alice', 'under_review')).status, 403);
  assert.equal((await move('rita', 'implemented')).status, 409);
  assert.equal((await move('rita', 'made_up')).status, 400);
  assert.equal((await move('bob', 'under_review')).status, 403);

  assert.equal((await move('rita', 'under_review')).body.status, 'under_review');
  // Still votable under review, and the edit lock now holds even with no votes.
  assert.equal((await call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: 1 } })).status, 200);
  assert.equal((await call('PATCH', `/proposals/${p.id}`, { body: { title: 'Changed under review' } })).status, 409);

  const accepted = await move('rita', 'accepted');
  assert.equal(accepted.body.status, 'accepted');
  assert.deepEqual(accepted.body.viewer.transitions, ['implemented']);
  // Voting closes once a decision is made; the tally stays as it stood.
  const closed = await call('PUT', `/proposals/${p.id}/vote`, { as: 'carol', body: { value: 1 } });
  assert.equal(closed.status, 409);
  assert.deepEqual(accepted.body.votes, { up: 1, down: 0, score: 1 });

  const done = await move('rita', 'implemented');
  assert.equal(done.body.status, 'implemented');
  assert.deepEqual(done.body.viewer.transitions, []);
  assert.equal((await move('rita', 'open')).status, 409);
  assert.deepEqual(
    done.body.history.map((h) => h.to),
    ['open', 'under_review', 'accepted', 'implemented'],
  );

  const implemented = await call('GET', '/proposals?view=implemented', { as: 'bob' });
  assert.equal(implemented.body.items[0].id, p.id);
  // Decided proposals leave the Popular ranking.
  const popular = await call('GET', '/proposals?view=popular', { as: 'bob' });
  assert.ok(!popular.body.items.some((x) => x.id === p.id));
});

test('popular ranks by stored score; nearby filters and sorts by distance', { skip }, async () => {
  const far = (await call('POST', '/proposals', {
    as: 'carol',
    body: { ...draft({ title: 'Far away library hours', category: 'update_hours', location: { name: 'Lisbon', lat: 38.72, lng: -9.14 } }), publish: true },
  })).body;
  const close = (await call('POST', '/proposals', {
    as: 'carol',
    body: { ...draft({ title: 'Close by bakery fix', category: 'correct_place', location: { name: 'Berlin Mitte', lat: 52.52, lng: 13.40 } }), publish: true },
  })).body;
  await call('PUT', `/proposals/${far.id}/vote`, { as: 'alice', body: { value: 1 } });
  await call('PUT', `/proposals/${far.id}/vote`, { as: 'bob', body: { value: 1 } });
  await call('PUT', `/proposals/${far.id}/vote`, { as: 'rita', body: { value: 1 } });
  await call('PUT', `/proposals/${close.id}/vote`, { as: 'alice', body: { value: -1 } });

  const popular = (await call('GET', '/proposals?view=popular', { as: 'bob' })).body.items;
  assert.equal(popular[0].id, far.id);
  assert.equal(popular[0].votes.score, 3);
  const scores = popular.map((x) => x.votes.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

  const nearby = (await call('GET', '/proposals?view=nearby&near=52.52,13.40&radius=10', { as: 'bob' })).body;
  assert.ok(nearby.items.length >= 1);
  assert.equal(nearby.items[0].id, close.id);
  assert.ok(nearby.items[0].distanceKm < 10);
  assert.ok(!nearby.items.some((x) => x.id === far.id));
  assert.ok(nearby.items.every((x, i, a) => i === 0 || a[i - 1].distanceKm <= x.distanceKm));
});

test('paging reports hasMore and the next offset', { skip }, async () => {
  const first = (await call('GET', '/proposals?view=recent&limit=2', { as: 'bob' })).body;
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  const second = (await call('GET', `/proposals?view=recent&limit=2&offset=${first.nextOffset}`, { as: 'bob' })).body;
  assert.ok(!second.items.some((x) => first.items.some((y) => y.id === x.id)));
});

test('policy gates can refuse a write and listeners hear committed changes', { skip }, async () => {
  const heard = [];
  policies.on('vote.cast', ({ value }) => heard.push(value));
  policies.registerGate('create', 'test-gate', ({ draft: d }) =>
    d.title.includes('BLOCKME') ? { code: 'possible_duplicate', message: 'Looks like a duplicate.', status: 409 } : null,
  );
  const refused = await call('POST', '/proposals', { body: draft({ title: 'BLOCKME please' }) });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'possible_duplicate');
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM proposals WHERE title LIKE 'BLOCKME%'");
  assert.equal(rows[0].n, 0);

  const p = (await call('POST', '/proposals', { body: { ...draft(), publish: true } })).body;
  await call('PUT', `/proposals/${p.id}/vote`, { as: 'bob', body: { value: -1 } });
  assert.deepEqual(heard, [-1]);
});

test('unknown and malformed ids are 404s', { skip }, async () => {
  assert.equal((await call('GET', '/proposals/999999999')).status, 404);
  assert.equal((await call('GET', '/proposals/abc')).status, 404);
  assert.equal((await call('PUT', '/proposals/abc/vote', { as: 'bob', body: { value: 1 } })).status, 404);
});

test('staging seed is idempotent and never involves the visitor', { skip }, async () => {
  const store = createStore({ pool, policies: createPolicies(), platformOrigin: ORIGIN });
  await store.seedStaging();
  await store.seedStaging();
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM proposals WHERE id BETWEEN 900001 AND 900099");
  assert.equal(rows[0].n, 7);
  const votes = await pool.query(
    "SELECT count(*)::int AS n FROM proposal_votes WHERE user_id NOT LIKE 'staging-demo-%' AND proposal_id >= 900001",
  );
  assert.equal(votes.rows[0].n, 0);
  const mine = (await call('GET', '/proposals?view=mine', { as: 'carol' })).body.items;
  assert.ok(mine.every((x) => x.author.username === 'carol'));
  const implemented = (await call('GET', '/proposals?view=implemented', { as: 'carol' })).body.items;
  const demo = implemented.find((x) => x.id === '900005');
  assert.deepEqual(demo.votes, { up: 6, down: 0, score: 6 });
});
