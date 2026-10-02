// Saved places store and routes against a REAL Postgres database.
//
// Each run creates its own throwaway schema, applies the boot migration and
// drives the actual HTTP routes (saved/routes.js over saved/store.js) with an
// express app whose only stand-in is the identity: a header names the
// signed-in person, as the platform token would. Nothing in the code under
// test is stubbed.
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL (the build
// worker's local Postgres). Skipped, loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createStore } = require('../saved/store');
const { createSavedRouter } = require('../saved/routes');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let base;
const schema = `saved_test_${process.pid}_${Date.now()}`;

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
  // A person who has never opened the Saved screen: their default lists have
  // never been seeded, which a deep link must still be able to reach.
  carol: { id: 103, username: 'carol' },
};

function place(overrides = {}) {
  return {
    id: 'photon:osm.node.12345',
    name: 'Corner Bakery',
    address: 'Kastanienallee 12, Berlin',
    category: 'place',
    subcategory: 'poi',
    lat: 52.5386,
    lng: 13.4108,
    source: 'photon',
    ...overrides,
  };
}

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  const store = createStore({ pool });
  await store.migrate();
  await store.migrate(); // the boot migration must be idempotent
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']];
    next();
  });
  app.use('/api/saved', createSavedRouter({ store }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/saved`;
});

test.after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('default lists are seeded on first read, in canonical order, once', { skip }, async () => {
  const first = await call('GET', '/lists');
  assert.equal(first.status, 200);
  const slugs = first.body.lists.filter((l) => l.kind === 'default').map((l) => l.systemKey);
  assert.deepEqual(slugs, ['favorites', 'want_to_visit', 'travel', 'restaurants']);
  assert.ok(first.body.lists.every((l) => l.kind === 'default'));

  // Reading again must not create a second copy of any default list.
  await call('GET', '/lists');
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM saved_lists WHERE user_id = '101' AND kind = 'default'",
  );
  assert.equal(rows[0].n, 4);
});

test('saving a place: idempotent, real id only, and per-user', { skip }, async () => {
  const saved = await call('POST', '/places', { body: { place: place() } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.placeId, 'photon:osm.node.12345');

  // Saving the same place again must not duplicate it.
  await call('POST', '/places', { body: { place: place() } });
  const alice = await call('GET', '/places');
  assert.equal(alice.body.places.length, 1);
  assert.equal(alice.body.places[0].name, 'Corner Bakery');

  // A place without an id is refused: no fabricated place is ever stored.
  const bad = await call('POST', '/places', { body: { place: { name: 'No id' } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_save');
  assert.ok(bad.body.error.fields.place);

  // Bob's saved places are his own; he sees nothing of Alice's.
  const bob = await call('GET', '/places', { as: 'bob' });
  assert.deepEqual(bob.body.places, []);
  const bobStatus = await call('GET', '/places/photon%3Aosm.node.12345/status', { as: 'bob' });
  assert.equal(bobStatus.body.saved, false);
  const aliceStatus = await call('GET', '/places/photon%3Aosm.node.12345/status');
  assert.equal(aliceStatus.body.saved, true);
});

test('save with a default list slug files it into that list', { skip }, async () => {
  const r = await call('POST', '/places', {
    as: 'bob',
    body: { place: place({ id: 'photon:osm.node.222' }), list: 'favorites' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.addedToList.systemKey, 'favorites');
  const fav = await call('GET', '/lists/favorites', { as: 'bob' });
  assert.equal(fav.status, 200);
  assert.equal(fav.body.items.length, 1);
  assert.equal(fav.body.items[0].id, 'photon:osm.node.222');
});

test('custom lists: create, rename, duplicate refusal, delete leaves the place', { skip }, async () => {
  const created = await call('POST', '/lists', { body: { name: 'Weekend trips' } });
  assert.equal(created.status, 200);
  assert.equal(created.body.name, 'Weekend trips');
  assert.equal(created.body.kind, 'custom');
  const id = created.body.id;

  // The same name again is refused by the case-insensitive unique index.
  const dup = await call('POST', '/lists', { body: { name: 'weekend TRIPS' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'duplicate_list');

  // A nameless list is refused by validation.
  assert.equal((await call('POST', '/lists', { body: { name: '   ' } })).status, 400);

  const renamed = await call('PATCH', `/lists/${id}`, { body: { name: 'Long weekends' } });
  assert.equal(renamed.body.name, 'Long weekends');
  assert.equal((await call('PATCH', `/lists/${id}`, { body: { name: '' } })).status, 400);

  // Default lists cannot be renamed or deleted.
  const favId = (await call('GET', '/lists')).body.lists.find((l) => l.systemKey === 'favorites').id;
  assert.equal((await call('PATCH', `/lists/${favId}`, { body: { name: 'Mine' } })).status, 403);
  assert.equal((await call('DELETE', `/lists/${favId}`)).status, 403);

  // A place in the list survives the list's deletion.
  const saved = await call('POST', `/lists/${id}/items`, {
    body: { place: place({ id: 'photon:osm.node.333', name: 'Hilltop Cafe' }) },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.added, true);
  // Adding again is idempotent.
  assert.equal((await call('POST', `/lists/${id}/items`, { body: { placeId: 'photon:osm.node.333' } })).body.added, false);

  const removedList = await call('DELETE', `/lists/${id}`);
  assert.equal(removedList.body.deleted, true);
  const stillSaved = await call('GET', '/places');
  assert.ok(stillSaved.body.places.some((p) => p.id === 'photon:osm.node.333'));
  assert.equal((await call('GET', `/lists/${id}`)).status, 404);
});

test('a default list is reachable before anything was ever saved', { skip }, async () => {
  // Carol has made no requests yet, so no default list exists for her. The
  // deep link the Saved screen supports (/#/saved?list=favorites) goes
  // straight to GET /lists/favorites; it must resolve, not 404.
  const { rows: before } = await pool.query(
    "SELECT count(*)::int AS n FROM saved_lists WHERE user_id = '103'",
  );
  assert.equal(before[0].n, 0);

  const fav = await call('GET', '/lists/favorites', { as: 'carol' });
  assert.equal(fav.status, 200);
  assert.equal(fav.body.systemKey, 'favorites');
  assert.equal(fav.body.kind, 'default');
  assert.deepEqual(fav.body.items, []);

  // And all four exist afterwards, each exactly once.
  const lists = await call('GET', '/lists', { as: 'carol' });
  const slugs = lists.body.lists.filter((l) => l.kind === 'default').map((l) => l.systemKey);
  assert.deepEqual(slugs, ['favorites', 'want_to_visit', 'travel', 'restaurants']);
});

test('ownership: another user cannot read or change a list or a membership', { skip }, async () => {
  const created = await call('POST', '/lists', { body: { name: 'Alice private list' } });
  const id = created.body.id;
  await call('POST', `/lists/${id}/items`, { body: { place: place({ id: 'photon:osm.node.444' }) } });

  // Bob cannot read the list, rename it, delete it, add to it or read items.
  assert.equal((await call('GET', `/lists/${id}`, { as: 'bob' })).status, 404);
  assert.equal((await call('PATCH', `/lists/${id}`, { as: 'bob', body: { name: 'Hijacked' } })).status, 404);
  assert.equal((await call('DELETE', `/lists/${id}`, { as: 'bob' })).status, 404);
  assert.equal((await call('POST', `/lists/${id}/items`, { as: 'bob', body: { placeId: 'photon:osm.node.444' } })).status, 404);
  assert.equal((await call('DELETE', `/lists/${id}/items`, { as: 'bob', body: { placeId: 'photon:osm.node.444' } })).status, 404);

  // Bob cannot file ALICE's saved place into HIS OWN list either: the
  // composite owner foreign key has no row to point at.
  const bobList = (await call('POST', '/lists', { as: 'bob', body: { name: 'Bobs list' } })).body;
  const cross = await call('POST', `/lists/${bobList.id}/items`, { as: 'bob', body: { placeId: 'photon:osm.node.444' } });
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error.code, 'not_saved');

  // Alice's list is untouched by all of it.
  const aliceList = await call('GET', `/lists/${id}`);
  assert.equal(aliceList.body.name, 'Alice private list');
  assert.equal(aliceList.body.items.length, 1);
});

test('duplicate membership is prevented by the membership primary key', { skip }, async () => {
  const list = (await call('POST', '/lists', { body: { name: 'Dupes' } })).body;
  await call('POST', `/lists/${list.id}/items`, { body: { place: place({ id: 'photon:osm.node.555' }) } });
  await call('POST', `/lists/${list.id}/items`, { body: { place: place({ id: 'photon:osm.node.555' }) } });
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM saved_list_items WHERE list_id = $1 AND place_id = $2',
    [list.id, 'photon:osm.node.555'],
  );
  assert.equal(rows[0].n, 1);
});

test('unsave removes the place from every list and is idempotent', { skip }, async () => {
  const list = (await call('POST', '/lists', { body: { name: 'Unsavers' } })).body;
  await call('POST', `/lists/${list.id}/items`, { body: { place: place({ id: 'photon:osm.node.666' }) } });
  assert.equal((await call('DELETE', '/places/photon%3Aosm.node.666')).body.removed, true);
  const detail = await call('GET', `/lists/${list.id}`);
  assert.deepEqual(detail.body.items, []);
  // Removing it again is a no-op, not an error.
  assert.equal((await call('DELETE', '/places/photon%3Aosm.node.666')).body.removed, false);
});

test('list contents, item removal and the combined overview', { skip }, async () => {
  const list = (await call('POST', '/lists', { body: { name: 'Contents check' } })).body;
  await call('POST', `/lists/${list.id}/items`, { body: { place: place({ id: 'photon:osm.node.777', name: 'One' }) } });
  await call('POST', `/lists/${list.id}/items`, { body: { place: place({ id: 'photon:osm.node.778', name: 'Two' }) } });
  const detail = await call('GET', `/lists/${list.id}`);
  assert.equal(detail.body.items.length, 2);
  assert.equal(detail.body.itemCount, 2);

  const removed = await call('DELETE', `/lists/${list.id}/items`, { body: { placeId: 'photon:osm.node.777' } });
  assert.equal(removed.body.removed, true);
  assert.equal((await call('GET', `/lists/${list.id}`)).body.items.length, 1);

  const overview = await call('GET', '/');
  assert.ok(Array.isArray(overview.body.lists));
  assert.ok(Array.isArray(overview.body.savedPlaceIds));
  assert.ok(overview.body.savedPlaceIds.includes('photon:osm.node.778'));
});

test('malformed ids and missing lists are typed errors, never a leak', { skip }, async () => {
  assert.equal((await call('GET', '/lists/abc')).status, 400);
  assert.equal((await call('GET', '/lists/999999')).status, 404);
  assert.equal((await call('GET', '/lists/nope')).status, 400);
  assert.equal((await call('POST', '/lists/999999/items', { body: { placeId: 'x' } })).status, 404);
});
