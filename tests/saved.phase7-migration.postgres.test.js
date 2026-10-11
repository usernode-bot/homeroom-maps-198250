// The boot migration over a database that already has Phase 7's saved-places
// tables, which is what production and every staging copy of it have. Phase 7
// used the names saved_lists and saved_list_items for a different shape, so a
// plain CREATE TABLE IF NOT EXISTS skipped them and the first index on
// owner_id failed the boot ("column owner_id does not exist"). Each run builds
// the Phase 7 schema below, exactly as Phase 7 shipped it, in a throwaway
// schema, fills it, and boots the current store over it twice.
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL. Skipped,
// loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createStore } = require('../saved/store');
const model = require('../saved/model');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let store;
const schema = `saved_phase7_test_${process.pid}_${Date.now()}`;

const PHASE7_SCHEMA_SQL = `
CREATE TABLE saved_lists (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('default','custom')),
  system_key TEXT CHECK (system_key IN ('favorites','want_to_visit','travel','restaurants')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT saved_lists_kind_key CHECK ((kind = 'default') = (system_key IS NOT NULL))
);
CREATE UNIQUE INDEX saved_lists_user_default_uniq
  ON saved_lists (user_id, system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX saved_lists_user_custom_name_uniq
  ON saved_lists (user_id, lower(name)) WHERE kind = 'custom';
CREATE INDEX saved_lists_user_idx ON saved_lists (user_id, created_at);
CREATE TABLE saved_places (
  user_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  name TEXT,
  address TEXT,
  category TEXT,
  subcategory TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, place_id),
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE TABLE saved_list_items (
  list_id BIGINT NOT NULL REFERENCES saved_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, place_id),
  FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, place_id) ON DELETE CASCADE
);
CREATE INDEX saved_list_items_place_idx ON saved_list_items (user_id, place_id);
`;

const ALICE = { id: 201, username: 'alice' };
const BOB = { id: 202, username: 'bob' };

// Phase 7 rows as its code wrote them: four defaults per person (alice renamed
// Favorites), a custom list, places in one list, in two lists, in none, and
// two that the new model cannot hold (no coordinates, no name).
async function fillPhase7() {
  const defaults = [['favorites', 'Favorites'], ['want_to_visit', 'Want to Visit'], ['travel', 'Travel'], ['restaurants', 'Restaurants']];
  const ids = {};
  for (const user of ['201', '202']) {
    for (const [key, name] of defaults) {
      const { rows } = await pool.query(
        `INSERT INTO saved_lists (user_id, name, kind, system_key, created_at)
         VALUES ($1, $2, 'default', $3, now() - interval '30 days') RETURNING id`,
        [user, user === '201' && key === 'favorites' ? 'My favourites' : name, key],
      );
      ids[`${user}:${key}`] = rows[0].id;
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO saved_lists (user_id, name, kind, created_at) VALUES ('201', 'Weekend', 'custom', now() - interval '20 days') RETURNING id`,
  );
  ids['201:weekend'] = rows[0].id;

  const places = [
    ['201', 'osm:way/123', 'Kastanienallee Espresso', 'Kastanienallee, Berlin', 'Food & drink', 'cafe', 52.53011, 13.40191, 'photon'],
    ['201', 'osm:node/9', 'Corner Bakery', null, 'Food & drink', null, 52.53861, 13.41084, 'unknown'],
    ['201', 'osm:node/10', 'No coordinates', null, null, null, null, null, 'photon'],
    ['201', '52.5,13.4', null, null, null, null, 52.5, 13.4, null],
    ['201', 'osm:node/11', 'Unlisted viewpoint', 'Prenzlauer Berg', 'Sights', null, 52.54, 13.42, 'photon'],
  ];
  for (const p of places) {
    await pool.query(
      `INSERT INTO saved_places (user_id, place_id, name, address, category, subcategory, lat, lng, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      p,
    );
  }
  const items = [
    [ids['201:favorites'], 'osm:way/123'],
    [ids['201:weekend'], 'osm:way/123'],
    [ids['201:want_to_visit'], 'osm:node/9'],
    [ids['201:favorites'], 'osm:node/10'],
    [ids['201:travel'], '52.5,13.4'],
  ];
  for (const [listId, placeId] of items) {
    await pool.query(
      `INSERT INTO saved_list_items (list_id, user_id, place_id) VALUES ($1, '201', $2)`,
      [listId, placeId],
    );
  }
  return ids;
}

let phase7Ids;

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  await pool.query(PHASE7_SCHEMA_SQL);
  phase7Ids = await fillPhase7();
  store = createStore({ pool });
  await store.migrate();
  await store.migrate(); // a second boot finds the new shape and copies nothing again
});

test.after(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('Phase 7 tables are moved aside, kept, and private', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT c.relname, obj_description(c.oid, 'pg_class') AS note
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE '%phase7'
      ORDER BY c.relname`,
    [schema],
  );
  assert.deepEqual(rows.map((r) => r.relname), ['saved_list_items_phase7', 'saved_lists_phase7', 'saved_places_phase7']);
  assert.ok(rows.every((r) => r.note === 'staging:private'));
  const legacy = await pool.query('SELECT count(*)::int AS n FROM saved_places_phase7');
  assert.equal(legacy.rows[0].n, 5);
});

test('everyone keeps their lists, in order, once, with their ids', { skip }, async () => {
  const mine = await store.listMine(ALICE, {});
  assert.deepEqual(
    mine.items.map((c) => [c.name, c.emoji, c.visibility]),
    [
      ['My favourites', '⭐', 'private'],
      ['Want to Visit', '🧭', 'private'],
      ['Travel', '✈️', 'private'],
      ['Restaurants', '🍴', 'private'],
      ['Weekend', model.EMOJIS[0], 'private'],
      ['Saved places', '🗺️', 'private'],
    ],
  );
  assert.equal(mine.items[0].id, String(phase7Ids['201:favorites']));
  assert.equal(mine.items[4].id, String(phase7Ids['201:weekend']));
  // Bob had only the defaults: still exactly four, not eight.
  const bob = await store.listMine(BOB, {});
  assert.deepEqual(bob.items.map((c) => c.name), ['Favorites', 'Want to Visit', 'Travel', 'Restaurants']);
});

test('places become items as the new client would have saved them', { skip }, async () => {
  const fav = await store.getDetail(ALICE, phase7Ids['201:favorites']);
  assert.deepEqual(fav.items.map((i) => i.place), [
    { name: 'Kastanienallee Espresso', address: 'Kastanienallee, Berlin', kind: 'cafe', provider: 'photon', lat: 52.53011, lng: 13.40191 },
  ]);
  assert.equal(fav.items[0].source, 'owner');
  const weekend = await store.getDetail(ALICE, phase7Ids['201:weekend']);
  assert.equal(weekend.items.length, 1);
  const want = await store.getDetail(ALICE, phase7Ids['201:want_to_visit']);
  assert.deepEqual(want.items.map((i) => [i.place.name, i.place.kind, i.place.provider]), [['Corner Bakery', 'Food & drink', null]]);
  // A coordinate-only place with no name cannot be an item.
  const travel = await store.getDetail(ALICE, phase7Ids['201:travel']);
  assert.deepEqual(travel.items, []);
  const mine = await store.listMine(ALICE, {});
  const unlisted = await store.getDetail(ALICE, mine.items[5].id);
  assert.deepEqual(unlisted.items.map((i) => i.place.name), ['Unlisted viewpoint']);

  // Adding the same place again is the same place_key, so it is refused.
  await assert.rejects(
    store.addItem(ALICE, phase7Ids['201:favorites'], {
      place: { name: 'Kastanienallee Espresso', lat: 52.53011, lng: 13.40191, provider: 'photon', id: 'osm:way/123' },
    }),
    (err) => err.code === 'already_in_list',
  );
});

test('copied lists stay owner-only, and the new tables keep working', { skip }, async () => {
  await assert.rejects(store.getDetail(BOB, phase7Ids['201:weekend']), (err) => err.code === 'not_found');
  const created = await store.create(ALICE, { name: 'New after migration', emoji: '☕' });
  assert.ok(Number(created.id) > phase7Ids['201:weekend']);
  // Making a copied list public writes the owner's real username.
  const updated = await store.update(ALICE, phase7Ids['201:weekend'], { visibility: 'public' });
  assert.equal(updated.owner.username, 'alice');
  const directory = await store.listPublic(BOB, {});
  assert.deepEqual(directory.items.map((c) => [c.name, c.owner.username]), [['Weekend', 'alice']]);
});

test('the assistant lists the places in your own lists, once each', { skip }, async () => {
  const places = await store.listPlaces(ALICE);
  assert.deepEqual(places.map((p) => p.name).sort(), ['Corner Bakery', 'Kastanienallee Espresso', 'Unlisted viewpoint']);
  assert.deepEqual(await store.listPlaces(BOB), []);
});
