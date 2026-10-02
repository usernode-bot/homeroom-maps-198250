// Saved places store — Postgres, per user, ownership enforced in every query.
//
// The rules come from saved/model.js; this module only enforces them against
// the database, inside transactions where two statements must agree.
//
// TWO OWNER CONSTRAINTS ARE STRUCTURAL, NOT CHECKS:
//   1. Every table is keyed by `user_id`, and EVERY query filters on it, so a
//      missing filter is a visible bug rather than a silent leak.
//   2. `saved_list_items` carries a composite foreign key
//      (user_id, place_id) -> saved_places(user_id, place_id). A row can
//      therefore only exist when BOTH the list and the place belong to the
//      same user, so nobody can file another person's place into their own
//      list or vice versa. That is what makes "a user must never read or
//      modify another user's private saved-place data" a database fact.
//
// Deleting a list removes the list and its memberships ONLY. The saved place
// lives in `saved_places`, which the list never owns, so unsaving is the only
// way a place itself disappears — deleting a list can never delete a place.
'use strict';

const model = require('./model');
const { SavedError, DEFAULT_LISTS, savedError } = model;

// Idempotent schema, applied on every boot (the repo's migration convention:
// CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, safe to re-run).
//
// None of these tables are marked staging:private. They hold only place ids
// and the display strings the signed-in person already saw in search (name,
// address, category, coordinates) plus the list names they chose. Every query
// filters by user_id, so another Homeroom user opening a staging preview sees
// their own empty saved-places surface, not this person's rows.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS saved_lists (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('default','custom')),
  system_key TEXT CHECK (system_key IN ('favorites','want_to_visit','travel','restaurants')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A default list is exactly the one whose system_key is set; a custom list
  -- is exactly the one without a system_key. Never both, never neither.
  CONSTRAINT saved_lists_kind_key CHECK ((kind = 'default') = (system_key IS NOT NULL))
);
-- One default list per person per system_key: the duplicate-prevention rule
-- for seeded defaults. A partial unique index, so it constrains only the rows
-- that have a system_key and leaves custom lists alone.
CREATE UNIQUE INDEX IF NOT EXISTS saved_lists_user_default_uniq
  ON saved_lists (user_id, system_key) WHERE system_key IS NOT NULL;
-- Two custom lists with the same name (case-insensitively) are refused, so a
-- person cannot create the same list twice. Default lists are excluded: their
-- names are seeded and may legitimately coincide with a custom name.
CREATE UNIQUE INDEX IF NOT EXISTS saved_lists_user_custom_name_uniq
  ON saved_lists (user_id, lower(name)) WHERE kind = 'custom';
CREATE INDEX IF NOT EXISTS saved_lists_user_idx ON saved_lists (user_id, created_at);

-- One saved place per (user, place). place_id is the REAL id the search
-- stack gives a result (search/normalize.js); the rest is the display data
-- that came with it, stored as given. Nothing here is generated.
CREATE TABLE IF NOT EXISTS saved_places (
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

-- List membership. The primary key is the duplicate-prevention rule: a place
-- can be in a list at most once. The composite foreign key is the ownership
-- rule: a membership can only reference a place owned by the SAME user.
CREATE TABLE IF NOT EXISTS saved_list_items (
  list_id BIGINT NOT NULL REFERENCES saved_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, place_id),
  FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, place_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS saved_list_items_place_idx ON saved_list_items (user_id, place_id);

-- Idempotent column addition, so a redeploy over an already-created table
-- (staging rebuilds on every push) still has every column this code reads.
ALTER TABLE saved_places ADD COLUMN IF NOT EXISTS subcategory TEXT;
`;

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function toList(row) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description || null,
    kind: row.kind,
    systemKey: row.system_key || null,
    isDefault: row.kind === 'default',
    itemCount: row.item_count == null ? undefined : Number(row.item_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toPlace(row) {
  return {
    id: row.place_id,
    name: row.name || null,
    address: row.address || null,
    category: row.category || null,
    subcategory: row.subcategory || null,
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    source: row.source || null,
    savedAt: iso(row.created_at),
    ...(row.list_ids ? { listIds: (row.list_ids || []).map(String) } : {}),
  };
}

const LIST_ORDER = `CASE l.system_key
    WHEN 'favorites' THEN 0 WHEN 'want_to_visit' THEN 1
    WHEN 'travel' THEN 2 WHEN 'restaurants' THEN 3 ELSE 4 END,
  l.created_at ASC, l.id ASC`;

function createStore({ pool }) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function migrate() {
    await pool.query(SCHEMA_SQL);
  }

  // Seed the four default lists for one person, if they are not there yet.
  // The partial unique index makes the ON CONFLICT a no-op on every later
  // call, so this is safe to run on every read as well as on first save.
  async function ensureDefaults(client, userId) {
    for (const list of DEFAULT_LISTS) {
      await client.query(
        `INSERT INTO saved_lists (user_id, name, kind, system_key)
         VALUES ($1, $2, 'default', $3)
         ON CONFLICT (user_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
        [userId, list.name, list.slug],
      );
    }
  }

  // The caller's copy of one list, by id, or null. Never touches another
  // person's row: user_id is part of the predicate.
  async function readList(client, userId, id) {
    const { rows } = await client.query(
      `SELECT l.*, (SELECT count(*) FROM saved_list_items i WHERE i.list_id = l.id)::int AS item_count
         FROM saved_lists l WHERE l.id = $1 AND l.user_id = $2`,
      [id, userId],
    );
    return rows[0] || null;
  }

  // Resolve a list reference from a request: one of the four default slugs,
  // or a numeric list id. Anything else is "no such list", never a guess at a
  // name, so a lookup can never reach a list the caller did not name exactly.
  async function resolveList(client, userId, ref) {
    const raw = typeof ref === 'string' || typeof ref === 'number' ? String(ref).trim() : '';
    if (!raw) throw savedError('invalid_request', 'A list is required.');
    if (model.isDefaultSlug(raw)) {
      const { rows } = await client.query(
        `SELECT l.*, (SELECT count(*) FROM saved_list_items i WHERE i.list_id = l.id)::int AS item_count
           FROM saved_lists l WHERE l.user_id = $1 AND l.system_key = $2`,
        [userId, raw],
      );
      if (!rows[0]) throw savedError('not_found', 'That list does not exist.', { status: 404 });
      return rows[0];
    }
    if (!/^\d{1,18}$/.test(raw)) {
      throw savedError('invalid_request', 'That list is not valid.');
    }
    const list = await readList(client, userId, raw);
    if (!list) throw savedError('not_found', 'That list does not exist.', { status: 404 });
    return list;
  }

  // Insert or refresh one saved place's cached display data. `created_at` is
  // left alone on conflict, so re-saving keeps the original saved date.
  async function upsertPlace(client, userId, place) {
    await client.query(
      `INSERT INTO saved_places (user_id, place_id, name, address, category, subcategory, lat, lng, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, place_id) DO UPDATE
          SET name = COALESCE(EXCLUDED.name, saved_places.name),
              address = COALESCE(EXCLUDED.address, saved_places.address),
              category = COALESCE(EXCLUDED.category, saved_places.category),
              subcategory = COALESCE(EXCLUDED.subcategory, saved_places.subcategory),
              lat = COALESCE(EXCLUDED.lat, saved_places.lat),
              lng = COALESCE(EXCLUDED.lng, saved_places.lng),
              source = COALESCE(EXCLUDED.source, saved_places.source)`,
      [userId, place.id, place.name, place.address, place.category, place.subcategory, place.lat, place.lng, place.source],
    );
  }

  async function isSaved(userId, rawPlaceId) {
    const placeId = model.validatePlaceId(rawPlaceId);
    const { rows } = await pool.query(
      'SELECT 1 FROM saved_places WHERE user_id = $1 AND place_id = $2',
      [userId, placeId],
    );
    return Boolean(rows[0]);
  }

  // Every saved place id for one person — the set the client uses to render
  // the toggle's true state without a call per place.
  async function savedPlaceIds(userId) {
    const { rows } = await pool.query(
      'SELECT place_id FROM saved_places WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => r.place_id);
  }

  // All the person's saved places, newest first, each carrying the list ids it
  // belongs to. One query; no per-place round trip.
  async function listPlaces(userId) {
    const { rows } = await pool.query(
      `SELECT p.*, COALESCE(m.list_ids, ARRAY[]::bigint[]) AS list_ids
         FROM saved_places p
         LEFT JOIN LATERAL (
           SELECT array_agg(i.list_id ORDER BY i.list_id) AS list_ids
             FROM saved_list_items i
            WHERE i.user_id = p.user_id AND i.place_id = p.place_id
         ) m ON true
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC, p.place_id`,
      [userId],
    );
    return rows.map(toPlace);
  }

  // The person's lists: the four defaults in their canonical order, then the
  // custom lists, each with its real item count. Seeding happens on the way
  // in, so the first read of the app always shows the four defaults and the
  // counts are counted from the membership rows, never stored.
  async function listLists(userId) {
    await tx((client) => ensureDefaults(client, userId));
    const { rows } = await pool.query(
      `SELECT l.*, (SELECT count(*) FROM saved_list_items i WHERE i.list_id = l.id)::int AS item_count
         FROM saved_lists l
        WHERE l.user_id = $1
        ORDER BY ${LIST_ORDER}`,
      [userId],
    );
    return rows.map(toList);
  }

  // One list with its contents. The reference may be a default list slug
  // (favorites, want_to_visit, travel, restaurants) or a numeric id. A list
  // the caller does not own is a 404, indistinguishable from a missing one.
  // Every read or write that can name a DEFAULT list seeds the four defaults
  // first, so a deep link or a direct API call reaches a real list even before
  // the person has ever opened the Saved screen. Idempotent, so it is safe on
  // every call.
  async function getList(userId, ref) {
    return tx(async (client) => {
      await ensureDefaults(client, userId);
      const list = await resolveList(client, userId, ref);
      const id = list.id;
      const { rows } = await client.query(
        `SELECT p.*, i.created_at AS added_at
           FROM saved_list_items i
           JOIN saved_places p ON p.user_id = i.user_id AND p.place_id = i.place_id
          WHERE i.list_id = $1 AND i.user_id = $2
          ORDER BY i.created_at DESC, p.place_id`,
        [id, userId],
      );
      return {
        ...toList(list),
        items: rows.map((r) => ({ ...toPlace(r), addedAt: iso(r.added_at) })),
      };
    });
  }

  async function createList(userId, input) {
    const { name, description } = model.validateCreateList(input);
    return tx(async (client) => {
      await ensureDefaults(client, userId);
      const { rows: countRows } = await client.query(
        "SELECT count(*)::int AS n FROM saved_lists WHERE user_id = $1 AND kind = 'custom'",
        [userId],
      );
      if (countRows[0].n >= model.LIMITS.maxCustomLists) {
        throw savedError(
          'limit_reached',
          `You can keep up to ${model.LIMITS.maxCustomLists} custom lists.`,
          { status: 409 },
        );
      }
      let inserted;
      try {
        ({ rows: inserted } = await client.query(
          `INSERT INTO saved_lists (user_id, name, description, kind)
           VALUES ($1, $2, $3, 'custom') RETURNING id`,
          [userId, name, description],
        ));
      } catch (err) {
        if (err && err.code === '23505') {
          throw savedError('duplicate_list', 'You already have a list with that name.', {
            status: 409,
            fields: { name: 'You already have a list with that name.' },
          });
        }
        throw err;
      }
      const list = await readList(client, userId, inserted[0].id);
      return toList(list);
    });
  }

  async function renameList(userId, rawId, input) {
    const id = model.validateListId(rawId);
    const { name } = model.validateUpdateList(input);
    return tx(async (client) => {
      const list = await readList(client, userId, id);
      if (!list) throw savedError('not_found', 'That list does not exist.', { status: 404 });
      if (list.kind === 'default') {
        throw savedError('forbidden', 'The default lists cannot be renamed.', { status: 403 });
      }
      try {
        await client.query(
          'UPDATE saved_lists SET name = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
          [id, userId, name],
        );
      } catch (err) {
        if (err && err.code === '23505') {
          throw savedError('duplicate_list', 'You already have a list with that name.', {
            status: 409,
            fields: { name: 'You already have a list with that name.' },
          });
        }
        throw err;
      }
      return toList(await readList(client, userId, id));
    });
  }

  // Delete a CUSTOM list. The default four cannot be deleted. The place rows
  // are not touched: memberships cascade away with the list, saved_places
  // keeps its rows, so the underlying place is never deleted.
  async function deleteList(userId, rawId) {
    const id = model.validateListId(rawId);
    return tx(async (client) => {
      const list = await readList(client, userId, id);
      if (!list) throw savedError('not_found', 'That list does not exist.', { status: 404 });
      if (list.kind === 'default') {
        throw savedError('forbidden', 'The default lists cannot be deleted.', { status: 403 });
      }
      await client.query('DELETE FROM saved_lists WHERE id = $1 AND user_id = $2', [id, userId]);
      return { deleted: true, id: String(id) };
    });
  }

  // Save a place (idempotent). With a list reference it is also filed into
  // that list. The place must carry a real id — model.validateSave rejects
  // anything else, so no placeholder is ever stored.
  async function save(userId, input) {
    const { place, listSlug } = model.validateSave(input);
    return tx(async (client) => {
      await ensureDefaults(client, userId);
      await upsertPlace(client, userId, place);
      let addedToList = null;
      if (listSlug) {
        const list = await resolveList(client, userId, listSlug);
        await client.query(
          `INSERT INTO saved_list_items (list_id, user_id, place_id) VALUES ($1,$2,$3)
           ON CONFLICT (list_id, place_id) DO NOTHING`,
          [list.id, userId, place.id],
        );
        addedToList = toList(list);
      }
      return { saved: true, placeId: place.id, addedToList };
    });
  }

  // Unsave a place. Removing it from saved_places cascades its memberships, so
  // the place leaves every list at once. Idempotent.
  async function unsave(userId, rawPlaceId) {
    const placeId = model.validatePlaceId(rawPlaceId);
    const { rowCount } = await pool.query(
      'DELETE FROM saved_places WHERE user_id = $1 AND place_id = $2',
      [userId, placeId],
    );
    return { saved: false, placeId, removed: rowCount > 0 };
  }

  // File an already-saved place into one of the person's lists. The composite
  // foreign key means this can only ever add their OWN place to their OWN
  // list; an idempotent conflict keeps a double tap from duplicating a row.
  async function addToList(userId, listRef, input) {
    const body = input && typeof input === 'object' ? input : {};
    const fields = {};
    const place = body.place ? model.validatePlace(body.place, fields) : null;
    const placeId = place ? place.id : model.validatePlaceId(body.placeId);
    if (Object.keys(fields).length) {
      throw savedError('invalid_save', 'Some details need fixing.', { fields });
    }
    return tx(async (client) => {
      await ensureDefaults(client, userId);
      const list = await resolveList(client, userId, listRef);
      if (place) {
        await upsertPlace(client, userId, place);
      } else {
        const { rows } = await client.query(
          'SELECT 1 FROM saved_places WHERE user_id = $1 AND place_id = $2',
          [userId, placeId],
        );
        if (!rows[0]) throw savedError('not_saved', 'Save this place before adding it to a list.', { status: 404 });
      }
      const { rows } = await client.query(
        `INSERT INTO saved_list_items (list_id, user_id, place_id) VALUES ($1,$2,$3)
         ON CONFLICT (list_id, place_id) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        [list.id, userId, placeId],
      );
      return {
        added: Boolean(rows[0] && rows[0].inserted),
        list: toList(await readList(client, userId, list.id)),
        placeId,
      };
    });
  }

  // Remove a place from one list. Idempotent: removing a membership that is
  // not there is not an error.
  async function removeFromList(userId, listRef, rawPlaceId) {
    const placeId = model.validatePlaceId(rawPlaceId);
    return tx(async (client) => {
      await ensureDefaults(client, userId);
      const list = await resolveList(client, userId, listRef);
      const { rowCount } = await client.query(
        'DELETE FROM saved_list_items WHERE list_id = $1 AND user_id = $2 AND place_id = $3',
        [list.id, userId, placeId],
      );
      return { removed: rowCount > 0, list: toList(await readList(client, userId, list.id)), placeId };
    });
  }

  return {
    migrate,
    isSaved,
    savedPlaceIds,
    listPlaces,
    listLists,
    getList,
    createList,
    renameList,
    deleteList,
    save,
    unsave,
    addToList,
    removeFromList,
  };
}

module.exports = { createStore, SCHEMA_SQL, toList, toPlace, SavedError };
