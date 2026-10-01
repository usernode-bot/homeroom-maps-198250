// Saved places store and routes against a REAL Postgres database, mirroring
// community.postgres.test.js: each run gets its own throwaway schema, the
// boot migration is applied (twice, for idempotence) and the actual HTTP
// routes (saved/routes.js over saved/store.js) are driven with an express
// app whose only stand-in is the identity header. Nothing in the code under
// test is stubbed.
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL. Skipped,
// loudly, when neither is set.
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

async function call(method, path, { as = 'alice', body, key } = {}) {
  const url = base + path;
  const res = await fetch(key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url, {
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
};

const BAKERY = {
  name: 'Corner Bakery',
  lat: 52.53861,
  lng: 13.41084,
  address: 'Kastanienallee, Berlin',
  kind: 'bakery',
  provider: 'photon',
  id: null,
};
const ESPRESSO = {
  name: 'Kastanienallee Espresso',
  lat: 52.53011,
  lng: 13.40191,
  address: 'Kastanienallee, Berlin',
  kind: 'cafe',
  provider: 'photon',
  id: 'osm:way/123',
};

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

test('first mine view lazily creates the four defaults, exactly once', { skip }, async () => {
  const first = await call('GET', '/lists?view=mine', { as: 'carol' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.items.map((c) => c.name),
    ['Favorites', 'Want to Visit', 'Travel', 'Restaurants']);
  assert.ok(first.body.items.every((c) => c.visibility === 'private'));
  assert.ok(first.body.items.every((c) => c.viewer.isOwner === true));
  assert.ok(first.body.items.every((c) => c.pendingSuggestions === 0));

  // A second read does not duplicate them.
  const second = await call('GET', '/lists?view=mine', { as: 'carol' });
  assert.equal(second.body.items.length, 4);

  // Deleting every one of them does not resurrect them: the flag row, not
  // the lists themselves, decides.
  for (const card of second.body.items) {
    const del = await call('DELETE', `/lists/${card.id}`, { as: 'carol' });
    assert.equal(del.status, 200);
  }
  const after = await call('GET', '/lists?view=mine', { as: 'carol' });
  assert.deepEqual(after.body.items, []);

  // Other people's defaults are invisible to carol.
  const bobMine = await call('GET', '/lists?view=mine', { as: 'bob' });
  assert.ok(bobMine.body.items.every((c) => c.owner.username === 'bob'));
});

test('create: validation errors name the field; a valid create answers a card', { skip }, async () => {
  const bad = await call('POST', '/lists', { as: 'bob', body: { name: '', emoji: '🎃', visibility: 'everyone' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_list');
  assert.ok(bad.body.error.fields.name);
  assert.ok(bad.body.error.fields.emoji);
  assert.ok(bad.body.error.fields.visibility);

  const ok = await call('POST', '/lists', {
    as: 'bob',
    body: { name: 'Bob bakeries', emoji: '🥐', visibility: 'public' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.visibility, 'public');
  assert.equal(ok.body.owner.username, 'bob');
  assert.equal(ok.body.itemCount, 0);
  assert.equal(ok.body.viewer.isOwner, true);
});

test('the visibility matrix: private is invisible everywhere, link needs the token, public is in the directory', { skip }, async () => {
  const priv = await call('POST', '/lists', { body: { name: 'Alice private', visibility: 'private' } });
  const pub = await call('POST', '/lists', { body: { name: 'Alice public', visibility: 'public' } });
  const shared = await call('POST', '/lists', { body: { name: 'Alice shared', visibility: 'private' } });
  const A = priv.body.id;
  const P = pub.body.id;
  const S = shared.body.id;

  // Switching to Shared mints the token once and keeps it stable.
  const toLink = await call('PATCH', `/lists/${S}`, { body: { visibility: 'link' } });
  assert.equal(toLink.status, 200);
  const token = toLink.body.shareToken;
  assert.match(token, /^[0-9a-f]{32}$/);
  const again = await call('PATCH', `/lists/${S}`, { body: { emoji: '⭐' } });
  assert.equal(again.body.shareToken, token);

  // Private: a non-owner gets 404, never 403, on every route that reads it.
  assert.equal((await call('GET', `/lists/${A}`, { as: 'bob' })).status, 404);
  assert.equal((await call('PATCH', `/lists/${A}`, { as: 'bob', body: { name: 'Hijack' } })).status, 404);
  assert.equal((await call('DELETE', `/lists/${A}`, { as: 'bob' })).status, 404);
  assert.equal((await call('POST', `/lists/${A}/items`, { as: 'bob', body: { place: BAKERY } })).status, 404);
  assert.equal((await call('POST', `/lists/${A}/suggestions`, { as: 'bob', body: { place: BAKERY } })).status, 404);

  // Link: invisible without the token, visible with it, writable by nobody
  // but the owner even with it.
  assert.equal((await call('GET', `/lists/${S}`, { as: 'carol' })).status, 404);
  const withKey = await call('GET', `/lists/${S}`, { as: 'carol', key: token });
  assert.equal(withKey.status, 200);
  assert.equal(withKey.body.viewer.canWrite, false);
  assert.equal(withKey.body.list.shareToken, undefined); // the token stays with the owner
  const asOwner = await call('GET', `/lists/${S}`);
  assert.equal(asOwner.body.list.shareToken, token);
  // Writes never accept the key: with the key alone carol simply cannot be
  // seen as a writer, so the write is an invisibility 404, not a 403.
  assert.equal((await call('PATCH', `/lists/${S}`, { as: 'carol', key: token, body: { name: 'Hijack' } })).status, 404);
  assert.equal((await call('GET', `/lists/${S}`, { as: 'carol', key: 'wrong-token' })).status, 404);

  // Public: any viewer reads it, nobody but the owner writes it.
  assert.equal((await call('GET', `/lists/${P}`, { as: 'carol' })).status, 200);
  assert.equal((await call('PATCH', `/lists/${P}`, { as: 'bob', body: { name: 'Hijack' } })).status, 403);
  assert.equal((await call('POST', `/lists/${P}/items`, { as: 'bob', body: { place: BAKERY } })).status, 403);
  assert.equal((await call('DELETE', `/lists/${P}`, { as: 'bob' })).status, 403);

  // Directory: public lists of OTHERS appear; private and link ones do not;
  // your own public list stays under Your lists instead.
  const carolPublic = (await call('GET', '/lists?view=public', { as: 'carol' })).body.items;
  assert.ok(carolPublic.some((c) => c.id === P));
  assert.ok(!carolPublic.some((c) => c.id === A));
  assert.ok(!carolPublic.some((c) => c.id === S));
  const bobPublic = (await call('GET', '/lists?view=public', { as: 'bob' })).body.items;
  assert.ok(bobPublic.some((c) => c.id === P)); // P is alice's: the directory is others' public lists
  assert.ok(!bobPublic.some((c) => c.owner.username === 'bob')); // bob's own public ones are under Your lists

  // The mine view only answers your own lists.
  const aliceMine = (await call('GET', '/lists?view=mine')).body.items.map((c) => c.id);
  assert.ok([A, P, S].every((id) => aliceMine.includes(id)));
});

test('items: snapshots are stored as given, deduped by place key, notes owner-only', { skip }, async () => {
  const pub = await call('POST', '/lists', { body: { name: 'Item fixture list', visibility: 'public' } });
  const id = pub.body.id;

  const added = await call('POST', `/lists/${id}/items`, { body: { place: BAKERY, note: 'Rye loaf before 10am.' } });
  assert.equal(added.status, 200);
  assert.equal(added.body.place.name, 'Corner Bakery');
  assert.equal(added.body.place.provider, 'photon');
  assert.equal(added.body.note, 'Rye loaf before 10am.');
  assert.equal(added.body.source, 'owner');
  assert.equal(added.body.addedBy.username, 'alice');
  assert.equal(added.body.commentCount, 0);

  // The same place again (a double tap, a retried request) is a typed 409,
  // even when only the coordinates' 5-decimal rounding matches.
  assert.equal((await call('POST', `/lists/${id}/items`, { body: { place: BAKERY } })).status, 409);
  const nearIdentical = await call('POST', `/lists/${id}/items`, {
    body: { place: { ...BAKERY, id: null, lat: 52.538612, lng: 13.410841, name: 'Corner Bakery (again)' } },
  });
  assert.equal(nearIdentical.status, 409);
  assert.equal(nearIdentical.body.error.code, 'already_in_list');

  // A different place lands fine.
  const second = await call('POST', `/lists/${id}/items`, { body: { place: ESPRESSO } });
  assert.equal(second.status, 200);

  // Invalid places are refused with the typed error.
  const invalid = await call('POST', `/lists/${id}/items`, { body: { place: { name: 'X', lat: 999, lng: 0 } } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_place');

  // The detail view carries items with their comment counts, and the
  // snapshot is served from the database, never re-fetched.
  const detail = await call('GET', `/lists/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.list.itemCount, 2);
  assert.deepEqual(detail.body.items.map((i) => i.place.name).sort(),
    ['Corner Bakery', 'Kastanienallee Espresso']);
  assert.equal(detail.body.viewer.canWrite, true);

  // Notes: the owner edits, anyone else is forbidden.
  const itemId = added.body.id;
  const noted = await call('PATCH', `/lists/${id}/items/${itemId}`, { body: { note: 'Go early.' } });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.note, 'Go early.');
  assert.equal((await call('PATCH', `/lists/${id}/items/${itemId}`, { as: 'bob', body: { note: 'x' } })).status, 403);
  assert.equal((await call('DELETE', `/lists/${id}/items/${itemId}`, { as: 'bob' })).status, 403);

  // A note of 500 characters is fine; 501 is refused.
  assert.equal((await call('PATCH', `/lists/${id}/items/${itemId}`, { body: { note: 'x'.repeat(500) } })).status, 200);
  const tooLong = await call('PATCH', `/lists/${id}/items/${itemId}`, { body: { note: 'x'.repeat(501) } });
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.body.error.fields.note);

  // Removing an item works, and the count follows.
  assert.equal((await call('DELETE', `/lists/${id}/items/${second.body.id}`)).status, 200);
  const after = await call('GET', `/lists/${id}`);
  assert.equal(after.body.list.itemCount, 1);
});

test('suggestions: pending for the owner, accept inserts the item, double decides and duplicates are typed 409s', { skip }, async () => {
  const pub = await call('POST', '/lists', { body: { name: 'Suggestion fixture list', visibility: 'public' } });
  const id = pub.body.id;

  // The owner does not suggest to their own list — they add directly.
  const own = await call('POST', `/lists/${id}/suggestions`, { body: { place: BAKERY } });
  assert.equal(own.status, 403);

  // A viewer suggests; the owner sees it in the detail, the suggester does not.
  const s1 = await call('POST', `/lists/${id}/suggestions`, { as: 'bob', body: { place: BAKERY, message: 'Best bread around.' } });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.status, 'pending');
  assert.equal(s1.body.from.username, 'bob');
  const ownerView = await call('GET', `/lists/${id}`);
  assert.equal(ownerView.body.suggestions.length, 1);
  assert.equal(ownerView.body.suggestions[0].place.name, 'Corner Bakery');
  const bobView = await call('GET', `/lists/${id}`, { as: 'bob' });
  assert.deepEqual(bobView.body.suggestions, []);

  // Another suggestion, which will be rejected later.
  const s2 = await call('POST', `/lists/${id}/suggestions`, { as: 'carol', body: { place: ESPRESSO } });
  assert.equal(s2.status, 200);

  // Non-owners cannot decide.
  assert.equal((await call('POST', `/suggestions/${s1.body.id}/accept`, { as: 'bob' })).status, 403);

  const accepted = await call('POST', `/suggestions/${s1.body.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.suggestion.status, 'accepted');
  assert.ok(accepted.body.item);
  assert.equal(accepted.body.item.source, 'suggestion');
  assert.equal(accepted.body.item.addedBy.username, 'bob'); // the suggester is credited
  assert.equal(accepted.body.item.place.name, 'Corner Bakery');

  // Deciding twice is a typed 409.
  const twice = await call('POST', `/suggestions/${s1.body.id}/accept`);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'already_decided');
  assert.equal((await call('POST', `/suggestions/${s1.body.id}/reject`)).status, 409);

  // A suggestion for a place already in the list rolls the WHOLE decision
  // back: the suggestion stays pending and answers already_in_list.
  const dup = await call('POST', `/lists/${id}/suggestions`, { as: 'carol', body: { place: BAKERY } });
  assert.equal(dup.status, 200);
  const dupAccept = await call('POST', `/suggestions/${dup.body.id}/accept`);
  assert.equal(dupAccept.status, 409);
  assert.equal(dupAccept.body.error.code, 'already_in_list');
  const stillPending = await call('GET', `/lists/${id}`);
  assert.ok(stillPending.body.suggestions.some((s) => s.id === dup.body.id && s.status === 'pending'));
  // The owner can decline it instead.
  const dupReject = await call('POST', `/suggestions/${dup.body.id}/reject`);
  assert.equal(dupReject.status, 200);
  assert.equal(dupReject.body.suggestion.status, 'rejected');

  // Rejecting leaves no item behind.
  const rejected = await call('POST', `/suggestions/${s2.body.id}/reject`);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.item, null);
  const finalDetail = await call('GET', `/lists/${id}`);
  assert.equal(finalDetail.body.list.itemCount, 1); // only the accepted one
  assert.deepEqual(finalDetail.body.suggestions, []); // decided ones stop surfacing
});

test('comments: anyone who can view reads and writes, author or owner deletes', { skip }, async () => {
  const pub = await call('POST', '/lists', { body: { name: 'Comment fixture list', visibility: 'public' } });
  const item = (await call('POST', `/lists/${pub.body.id}/items`, { body: { place: BAKERY } })).body;

  const bobs = await call('POST', `/items/${item.id}/comments`, { as: 'bob', body: { body: 'The rye loaf is the one.' } });
  assert.equal(bobs.status, 200);
  assert.equal(bobs.body.author.username, 'bob');
  const carols = await call('POST', `/items/${item.id}/comments`, { as: 'carol', body: { body: 'Agreed.' } });
  assert.equal(carols.status, 200);

  // Empty and over-long comments are typed 400s.
  assert.equal((await call('POST', `/items/${item.id}/comments`, { as: 'bob', body: { body: '   ' } })).status, 400);
  const long = await call('POST', `/items/${item.id}/comments`, { as: 'bob', body: { body: 'x'.repeat(1001) } });
  assert.equal(long.status, 400);
  assert.equal(long.body.error.code, 'comment_too_long');

  let thread = await call('GET', `/items/${item.id}/comments`, { as: 'carol' });
  assert.equal(thread.status, 200);
  assert.equal(thread.body.items.length, 2);

  // Only the author or the list owner deletes; another viewer is forbidden.
  assert.equal((await call('DELETE', `/comments/${carols.body.id}`, { as: 'bob' })).status, 403);
  assert.equal((await call('DELETE', `/comments/${carols.body.id}`, { as: 'carol' })).status, 200);
  assert.equal((await call('DELETE', `/comments/${bobs.body.id}`)).status, 200); // the owner moderates

  thread = await call('GET', `/items/${item.id}/comments`);
  assert.deepEqual(thread.body.items, []);

  // The comment count rides on the list detail's items.
  await call('POST', `/items/${item.id}/comments`, { as: 'bob', body: { body: 'One more.' } });
  const detail = await call('GET', `/lists/${pub.body.id}`);
  assert.equal(detail.body.items.find((i) => i.id === item.id).commentCount, 1);
});

test('comments on a link list ride the key; comments on a private list are unreachable', { skip }, async () => {
  const shared = await call('POST', '/lists', { body: { name: 'Shared comments list' } });
  const id = shared.body.id;
  const toLink = await call('PATCH', `/lists/${id}`, { body: { visibility: 'link' } });
  const token = toLink.body.shareToken;
  const item = (await call('POST', `/lists/${id}/items`, { body: { place: BAKERY } })).body;

  // Without the key: unreadable. With it: readable and writable.
  assert.equal((await call('GET', `/items/${item.id}/comments`, { as: 'carol' })).status, 404);
  assert.equal((await call('POST', `/items/${item.id}/comments`, { as: 'carol', body: { body: 'hi' } })).status, 404);
  assert.equal((await call('GET', `/items/${item.id}/comments`, { as: 'carol', key: token })).status, 200);
  const posted = await call('POST', `/items/${item.id}/comments`, { as: 'carol', key: token, body: { body: 'From the link.' } });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.body, 'From the link.');

  // A private list's comments are unreachable for others, by id alone too.
  const priv = await call('POST', '/lists', { body: { name: 'Private comments list' } });
  const privItem = (await call('POST', `/lists/${priv.body.id}/items`, { body: { place: ESPRESSO } })).body;
  await call('POST', `/items/${privItem.id}/comments`, { body: { body: 'Just for me.' } });
  assert.equal((await call('GET', `/items/${privItem.id}/comments`, { as: 'bob' })).status, 404);
});

test('deleting a list cascades to its items, comments and suggestions', { skip }, async () => {
  const pub = await call('POST', '/lists', { body: { name: 'Cascade fixture list', visibility: 'public' } });
  const id = pub.body.id;
  const item = (await call('POST', `/lists/${id}/items`, { body: { place: BAKERY } })).body;
  await call('POST', `/items/${item.id}/comments`, { as: 'bob', body: { body: 'Gone soon.' } });
  await call('POST', `/lists/${id}/suggestions`, { as: 'bob', body: { place: ESPRESSO } });

  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM saved_list_items WHERE list_id = $1) AS items,
       (SELECT count(*)::int FROM saved_item_comments WHERE list_id = $1) AS comments,
       (SELECT count(*)::int FROM saved_list_suggestions WHERE list_id = $1) AS suggestions`,
    [id],
  );
  assert.deepEqual(rows[0], { items: 1, comments: 1, suggestions: 1 });

  assert.equal((await call('DELETE', `/lists/${id}`)).status, 200);
  const { rows: after } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM saved_list_items WHERE list_id = $1) AS items,
       (SELECT count(*)::int FROM saved_item_comments WHERE list_id = $1) AS comments,
       (SELECT count(*)::int FROM saved_list_suggestions WHERE list_id = $1) AS suggestions`,
    [id],
  );
  assert.deepEqual(after[0], { items: 0, comments: 0, suggestions: 0 });
  assert.equal((await call('GET', `/lists/${id}`)).status, 404);
});

test('the public directory pages with hasMore and nextOffset', { skip }, async () => {
  // carol makes three public lists; they are the only directory entries
  // beyond the earlier fixtures.
  for (const n of ['Carol paging 1', 'Carol paging 2', 'Carol paging 3']) {
    await call('POST', '/lists', { as: 'carol', body: { name: n, visibility: 'public' } });
  }
  const page1 = await call('GET', '/lists?view=public&limit=2', { as: 'alice' });
  assert.equal(page1.status, 200);
  if (page1.body.hasMore) {
    assert.equal(page1.body.items.length, 2);
    const page2 = await call('GET', `/lists?view=public&limit=2&offset=${page1.body.nextOffset}`, { as: 'alice' });
    assert.ok(!page2.body.items.some((x) => page1.body.items.some((y) => y.id === x.id)));
  }
  // The mine view pages the same way.
  const minePage = await call('GET', '/lists?view=mine&limit=2');
  assert.equal(minePage.body.items.length, Math.min(2, minePage.body.items.length));
});

test('unknown and malformed ids are 404s', { skip }, async () => {
  assert.equal((await call('GET', '/lists/999999999')).status, 404);
  assert.equal((await call('GET', '/lists/abc')).status, 404);
  assert.equal((await call('GET', '/items/abc/comments')).status, 404);
  assert.equal((await call('POST', '/suggestions/abc/accept', { body: {} })).status, 404);
  assert.equal((await call('GET', '/items/999999999/comments')).status, 404);
});

test('staging seed is idempotent, obviously fake, private, and never about the visitor', { skip }, async () => {
  const store = createStore({ pool });
  await store.seedStaging();
  await store.seedStaging();
  const lists = await pool.query('SELECT count(*)::int AS n FROM saved_lists WHERE id BETWEEN 900001 AND 900099');
  assert.equal(lists.rows[0].n, 5);
  const items = await pool.query('SELECT count(*)::int AS n FROM saved_list_items WHERE id BETWEEN 900101 AND 900199');
  assert.equal(items.rows[0].n, 7);
  const comments = await pool.query('SELECT count(*)::int AS n FROM saved_item_comments WHERE id BETWEEN 900301 AND 900399');
  assert.equal(comments.rows[0].n, 2);
  const suggestions = await pool.query('SELECT count(*)::int AS n FROM saved_list_suggestions WHERE id BETWEEN 900201 AND 900299');
  assert.equal(suggestions.rows[0].n, 3);

  // Every seeded identity is a fake staging one.
  const owners = await pool.query(
    "SELECT count(*)::int AS n FROM saved_lists WHERE id >= 900001 AND owner_id NOT LIKE 'staging-demo-%'",
  );
  assert.equal(owners.rows[0].n, 0);

  // The private demo list is invisible to every real viewer, including via
  // the directory and detail route.
  const directory = (await call('GET', '/lists?view=public', { as: 'alice' })).body.items;
  assert.ok(!directory.some((c) => c.id === '900005'));
  assert.ok(directory.some((c) => c.id === '900001'));
  assert.equal((await call('GET', '/lists/900005', { as: 'alice' })).status, 404);

  // The public demo list is readable with its items and comments, and the
  // pending demo suggestion is waiting for nobody (the viewer is not the owner).
  const demo = await call('GET', '/lists/900001', { as: 'alice' });
  assert.equal(demo.status, 200);
  assert.equal(demo.body.items.length, 2);
  assert.equal(demo.body.items[0].commentCount, 1);
  assert.deepEqual(demo.body.suggestions, []); // not the owner: no suggestions surfaced
});