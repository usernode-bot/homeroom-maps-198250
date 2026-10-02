// The Profile read model (saved/profiles.js) against a REAL Postgres database.
//
// It reads the community tables through the same aggregate the community feed
// computes, so the actual SQL runs here against real rows. Needs a database:
// TEST_DATABASE_URL, else INLOOP_DATABASE_URL.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPolicies } = require('../community/policies');
const { createStore } = require('../community/store');
const { createProfiles } = require('../saved/profiles');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let community;
let profiles;
const schema = `profile_test_${process.pid}_${Date.now()}`;

const AUTHOR = { id: '201', username: 'author' };
const VOTER = { id: '202', username: 'voter' };

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  community = createStore({ pool, policies: createPolicies() });
  await community.migrate();
  profiles = createProfiles({ pool });
});

test.after(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('an untouched account has zero of everything', { skip }, async () => {
  const overview = await profiles.overview('999');
  assert.deepEqual(overview.contributions, { proposals: 0, published: 0, implemented: 0 });
  assert.deepEqual(overview.votes, { votes: 0, up: 0, down: 0 });
  assert.deepEqual(overview.proposals, []);
  assert.deepEqual(overview.voted, []);
});

test('the overview counts real proposals and votes, and only the caller own', { skip }, async () => {
  const draft = await community.create(AUTHOR, {
    title: 'A draft nobody else can see',
    description: 'Still being written up before it goes out.',
    category: 'add_missing_place',
    location: { name: 'Berlin', lat: 52.52, lng: 13.4 },
  });
  const published = await community.create(AUTHOR, {
    title: 'A published proposal',
    description: 'This one is open for votes already.',
    category: 'correct_place',
    location: { name: 'Berlin', lat: 52.52, lng: 13.4 },
    publish: true,
  });
  await community.vote(VOTER, published.id, 1);

  const author = await profiles.overview(AUTHOR.id);
  assert.equal(author.contributions.proposals, 2); // the draft counts as theirs
  assert.equal(author.contributions.published, 1); // only the open one is a contribution
  assert.equal(author.contributions.implemented, 0);
  assert.equal(author.votes.votes, 0);
  // Their own list includes the draft — they are its author.
  assert.ok(author.proposals.some((p) => p.id === draft.id && p.status === 'draft'));

  const voter = await profiles.overview(VOTER.id);
  assert.deepEqual(voter.votes, { votes: 1, up: 1, down: 0 });
  assert.equal(voter.contributions.proposals, 0);
  // Nobody else's draft is ever in another person's list.
  assert.deepEqual(voter.proposals, []);
  assert.equal(voter.voted.length, 1);
  assert.equal(voter.voted[0].id, published.id);
  assert.equal(voter.voted[0].myVote, 1);
});

test('a rejected proposal is still a published contribution; a draft is not', { skip }, async () => {
  const p = await community.create(AUTHOR, {
    title: 'Rejected idea',
    description: 'A proposal that a reviewer turns down.',
    category: 'correct_place',
    location: { name: 'Berlin', lat: 52.52, lng: 13.4 },
    publish: true,
  });
  // A reviewer moves it to rejected (the model's lifecycle).
  await community.transition({ ...AUTHOR, reviewer: true }, p.id, 'under_review');
  await community.transition({ ...AUTHOR, reviewer: true }, p.id, 'rejected');
  const overview = await profiles.overview(AUTHOR.id);
  const rejected = overview.proposals.find((x) => x.id === p.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.statusLabel, 'Rejected');
  // "published" means every proposal its author shared (drafts excluded), so
  // the open one from the previous test and this rejected one both count.
  assert.equal(overview.contributions.proposals, 3);
  assert.equal(overview.contributions.published, 2);
  assert.equal(overview.contributions.implemented, 0);
});
