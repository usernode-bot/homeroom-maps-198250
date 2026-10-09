// Saved places store — lists, items, suggestions and comments in Postgres.
//
// The rules come from model.js; this module only enforces them against the
// database, inside transactions, so a rule can never be bypassed by a race.
// Nothing here is a counter: place counts, comment counts and pending
// suggestion counts are all aggregated from their tables on read, so the
// number shown is always exactly the rows that exist.
//
// All four tables are staging:private: a saved list is private-by-default
// personal data, and a comment row records how a named person commented,
// exactly as proposal_votes records how a named person voted.
'use strict';

const model = require('./model');
const { SavedError } = model;

// Idempotent schema, applied on every boot.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS saved_lists (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','link','public')),
  share_token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_lists_owner_idx ON saved_lists (owner_id, created_at);
CREATE INDEX IF NOT EXISTS saved_lists_visibility_idx ON saved_lists (visibility, updated_at DESC);
COMMENT ON TABLE saved_lists IS 'staging:private';

CREATE TABLE IF NOT EXISTS saved_list_items (
  id BIGSERIAL PRIMARY KEY,
  list_id BIGINT NOT NULL REFERENCES saved_lists(id) ON DELETE CASCADE,
  place_key TEXT NOT NULL,
  place_name TEXT NOT NULL,
  place_address TEXT,
  place_kind TEXT,
  place_provider TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','suggestion')),
  added_by_id TEXT,
  added_by_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (list_id, place_key)
);
CREATE INDEX IF NOT EXISTS saved_list_items_list_idx ON saved_list_items (list_id, created_at);
COMMENT ON TABLE saved_list_items IS 'staging:private';

CREATE TABLE IF NOT EXISTS saved_list_suggestions (
  id BIGSERIAL PRIMARY KEY,
  list_id BIGINT NOT NULL REFERENCES saved_lists(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  from_username TEXT NOT NULL,
  message TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS saved_list_suggestions_list_idx
  ON saved_list_suggestions (list_id, status, created_at);
COMMENT ON TABLE saved_list_suggestions IS 'staging:private';

CREATE TABLE IF NOT EXISTS saved_item_comments (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES saved_list_items(id) ON DELETE CASCADE,
  list_id BIGINT NOT NULL REFERENCES saved_lists(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_username TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_item_comments_item_idx ON saved_item_comments (item_id, created_at);
COMMENT ON TABLE saved_item_comments IS 'staging:private';

-- One row per person, created the first time their lists are read: the flag
-- that the four default lists have been ensured, so deleting every list of
-- your own never resurrects them.
CREATE TABLE IF NOT EXISTS saved_user_state (
  user_id TEXT PRIMARY KEY,
  defaults_ensured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE saved_user_state IS 'staging:private';
`;

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function parseId(raw, message) {
  if (!/^\d{1,18}$/.test(String(raw))) {
    throw new SavedError('not_found', message || 'That list does not exist.', { status: 404 });
  }
  return String(raw);
}

// The row as the rules see it.
function toList(row) {
  return {
    id: String(row.id),
    ownerId: row.owner_id,
    visibility: row.visibility,
    shareToken: row.share_token,
  };
}

// The API card shape. `viewer` decides what the card carries: the share
// token and the pending-suggestion count exist only for the owner.
function toCard(row, viewer) {
  const owner = model.isOwner(viewer, toList(row));
  const out = {
    id: String(row.id),
    name: row.name,
    emoji: row.emoji,
    visibility: row.visibility,
    owner: { id: row.owner_id, username: row.owner_username },
    itemCount: row.item_count || 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    viewer: { isOwner: owner, canWrite: owner },
  };
  if (owner && row.pending_suggestions != null) out.pendingSuggestions = row.pending_suggestions;
  if (owner && row.visibility === 'link' && row.share_token) out.shareToken = row.share_token;
  return out;
}

function toSuggestion(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    id: String(row.id),
    listId: String(row.list_id),
    from: { id: row.from_id, username: row.from_username },
    message: row.message || null,
    place: {
      name: payload.name,
      lat: Number(payload.lat),
      lng: Number(payload.lng),
      address: payload.address || null,
      kind: payload.kind || null,
      provider: payload.provider || null,
      id: payload.id || null,
    },
    status: row.status,
    createdAt: iso(row.created_at),
    decidedAt: iso(row.decided_at),
  };
}

function toItem(row) {
  return {
    id: String(row.id),
    listId: String(row.list_id),
    place: {
      name: row.place_name,
      address: row.place_address,
      kind: row.place_kind,
      provider: row.place_provider,
      lat: Number(row.lat),
      lng: Number(row.lng),
    },
    note: row.note || null,
    source: row.source,
    addedBy: { id: row.added_by_id, username: row.added_by_username },
    createdAt: iso(row.created_at),
    commentCount: row.comment_count || 0,
  };
}

function toComment(row) {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    author: { id: row.author_id, username: row.author_username },
    body: row.body,
    createdAt: iso(row.created_at),
  };
}

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

  // Read one list row and apply THE visibility predicate. A viewer who
  // cannot see the list gets "not found", never "forbidden", so a private
  // list's existence never leaks through any endpoint.
  async function readList(db, viewer, id, { key = null } = {}) {
    const { rows } = await db.query('SELECT * FROM saved_lists WHERE id = $1', [id]);
    const row = rows[0];
    if (!row || !model.canView(viewer, toList(row), { key })) {
      throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
    }
    return row;
  }

  // The item counts live on every card; the pending-suggestion count is a
  // second aggregate the owner's views add.
  const COUNTS_SELECT = `
SELECT l.*,
       (SELECT count(*) FROM saved_list_items i WHERE i.list_id = l.id)::int AS item_count,
       (SELECT count(*) FROM saved_list_suggestions s
          WHERE s.list_id = l.id AND s.status = 'pending')::int AS pending_suggestions
  FROM saved_lists l`;

  // The four roadmap defaults, created exactly once per person: the flag row
  // decides, and the insert is conditional on it inside one transaction, so
  // two concurrent first reads cannot double-create. Deleting every list of
  // your own afterwards never resurrects them.
  async function ensureDefaults(viewer) {
    await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO saved_user_state (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
        [viewer.id],
      );
      if (!rows[0]) return;
      for (const def of model.DEFAULT_LISTS) {
        await client.query(
          `INSERT INTO saved_lists (owner_id, owner_username, name, emoji, visibility)
           VALUES ($1, $2, $3, $4, 'private')`,
          [viewer.id, viewer.username, def.name, def.emoji],
        );
      }
    });
  }

  async function listMine(viewer, rawQuery) {
    await ensureDefaults(viewer);
    const q = model.parsePageQuery(rawQuery);
    // Creation order: the defaults first, then custom lists in the order
    // they were made — the way a person builds up their collection.
    const { rows } = await pool.query(
      `${COUNTS_SELECT} WHERE l.owner_id = $1 ORDER BY l.created_at, l.id LIMIT $2 OFFSET $3`,
      [viewer.id, q.limit + 1, q.offset],
    );
    const hasMore = rows.length > q.limit;
    return {
      view: 'mine',
      items: rows.slice(0, q.limit).map((r) => toCard(r, viewer)),
      hasMore,
      nextOffset: hasMore ? q.offset + q.limit : null,
    };
  }

  // The public directory: other people's public lists, newest activity
  // first. The viewer's own public lists stay out — they manage those under
  // Your lists.
  async function listPublic(viewer, rawQuery) {
    const q = model.parsePageQuery(rawQuery);
    const { rows } = await pool.query(
      `${COUNTS_SELECT} WHERE l.visibility = 'public' AND l.owner_id <> $1
       ORDER BY l.updated_at DESC, l.id DESC LIMIT $2 OFFSET $3`,
      [viewer.id, q.limit + 1, q.offset],
    );
    const hasMore = rows.length > q.limit;
    return {
      view: 'public',
      items: rows.slice(0, q.limit).map((r) => toCard(r, viewer)),
      hasMore,
      nextOffset: hasMore ? q.offset + q.limit : null,
    };
  }

  async function getDetail(viewer, rawId, { key = null } = {}) {
    const id = parseId(rawId);
    const row = await readList(pool, viewer, id, { key });
    const isOwner = model.isOwner(viewer, toList(row));
    const { rows: items } = await pool.query(
      `SELECT i.*, (SELECT count(*) FROM saved_item_comments c WHERE c.item_id = i.id)::int AS comment_count
         FROM saved_list_items i WHERE i.list_id = $1 ORDER BY i.created_at, i.id`,
      [id],
    );
    let suggestions = [];
    if (isOwner) {
      // Pending decisions first, oldest first: the order a person works
      // through them. Decided suggestions stay in the database but are not
      // re-surfaced.
      const { rows } = await pool.query(
        `SELECT * FROM saved_list_suggestions WHERE list_id = $1 AND status = 'pending'
         ORDER BY created_at, id LIMIT 50`,
        [id],
      );
      suggestions = rows.map(toSuggestion);
    }
    // The list detail answers its counts from what it just read, so the
    // card and the sections below it can never disagree.
    const cardRow = { ...row, item_count: items.length, pending_suggestions: isOwner ? suggestions.length : 0 };
    return {
      list: toCard(cardRow, viewer),
      items: items.map(toItem),
      suggestions,
      viewer: { isOwner, canWrite: isOwner },
    };
  }

  async function create(viewer, rawBody) {
    const input = model.validateListInput(rawBody);
    const { rows } = await pool.query(
      `INSERT INTO saved_lists (owner_id, owner_username, name, emoji, visibility)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [viewer.id, viewer.username, input.name, input.emoji, input.visibility],
    );
    return toCard(
      (await pool.query(`${COUNTS_SELECT} WHERE l.id = $1`, [rows[0].id])).rows[0],
      viewer,
    );
  }

  async function update(viewer, rawId, rawBody) {
    const id = parseId(rawId);
    await tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM saved_lists WHERE id = $1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row || !model.canView(viewer, toList(row))) {
        throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
      }
      if (!model.canWrite(viewer, toList(row))) {
        throw new SavedError('forbidden', 'Only the list owner can change it.', { status: 403 });
      }
      const merged = model.validateListInput(
        {
          name: 'name' in (rawBody || {}) ? rawBody.name : row.name,
          emoji: 'emoji' in (rawBody || {}) ? rawBody.emoji : row.emoji,
          visibility: 'visibility' in (rawBody || {}) ? rawBody.visibility : row.visibility,
        },
        { partial: false },
      );
      // The token is minted the first time a list becomes Shared and then
      // stays stable, so a link that has been copied keeps working.
      const shareToken =
        merged.visibility === 'link'
          ? row.share_token || model.generateShareToken()
          : row.share_token;
      await client.query(
        `UPDATE saved_lists SET name = $2, emoji = $3, visibility = $4, share_token = $5, updated_at = now()
          WHERE id = $1`,
        [id, merged.name, merged.emoji, merged.visibility, shareToken],
      );
    });
    return toCard(
      (await pool.query(`${COUNTS_SELECT} WHERE l.id = $1`, [id])).rows[0],
      viewer,
    );
  }

  async function remove(viewer, rawId) {
    const id = parseId(rawId);
    await tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM saved_lists WHERE id = $1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row || !model.canView(viewer, toList(row))) {
        throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
      }
      if (!model.canWrite(viewer, toList(row))) {
        throw new SavedError('forbidden', 'Only the list owner can delete it.', { status: 403 });
      }
      await client.query('DELETE FROM saved_lists WHERE id = $1', [id]);
    });
    return { ok: true };
  }

  async function addItem(viewer, rawListId, rawBody) {
    const listId = parseId(rawListId);
    const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const place = model.validatePlace(body.place);
    const note = model.validateNote(body.note);
    const key = model.placeKeyOf(place);
    let inserted = false;
    const item = await tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM saved_lists WHERE id = $1 FOR UPDATE', [listId]);
      const row = rows[0];
      if (!row || !model.canView(viewer, toList(row))) {
        throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
      }
      if (!model.canWrite(viewer, toList(row))) {
        throw new SavedError('forbidden', 'Only the list owner can add places.', { status: 403 });
      }
      // The UNIQUE (list_id, place_key) constraint is the backstop: a double
      // tap or a retried request can never duplicate a row.
      const { rows: insertedRows } = await client.query(
        `INSERT INTO saved_list_items
           (list_id, place_key, place_name, place_address, place_kind, place_provider, lat, lng, note, source, added_by_id, added_by_username)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'owner',$10,$11)
         ON CONFLICT (list_id, place_key) DO NOTHING
         RETURNING *`,
        [listId, key, place.name, place.address, place.kind, place.provider, place.lat, place.lng, note, viewer.id, viewer.username],
      );
      if (!insertedRows[0]) {
        throw new SavedError('already_in_list', 'This place is already in the list.', { status: 409 });
      }
      inserted = true;
      return toItem(insertedRows[0]);
    });
    await touch(listId);
    return item;
  }

  async function updateItem(viewer, rawListId, rawItemId, rawBody) {
    const listId = parseId(rawListId);
    const itemId = parseId(rawItemId);
    const note = model.validateNote(rawBody && rawBody.note);
    await tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM saved_lists WHERE id = $1 FOR UPDATE', [listId]);
      const row = rows[0];
      if (!row || !model.canView(viewer, toList(row))) {
        throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
      }
      if (!model.canWrite(viewer, toList(row))) {
        throw new SavedError('forbidden', 'Only the list owner can edit notes.', { status: 403 });
      }
      const { rowCount } = await client.query(
        'UPDATE saved_list_items SET note = $2 WHERE id = $3 AND list_id = $1',
        [listId, note, itemId],
      );
      if (!rowCount) {
        throw new SavedError('not_found', 'That place is not in this list.', { status: 404 });
      }
    });
    await touch(listId);
    return toItem(
      (await pool.query('SELECT *, 0::int AS comment_count FROM saved_list_items WHERE id = $1', [itemId])).rows[0],
    );
  }

  async function removeItem(viewer, rawListId, rawItemId) {
    const listId = parseId(rawListId);
    const itemId = parseId(rawItemId);
    await tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM saved_lists WHERE id = $1 FOR UPDATE', [listId]);
      const row = rows[0];
      if (!row || !model.canView(viewer, toList(row))) {
        throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
      }
      if (!model.canWrite(viewer, toList(row))) {
        throw new SavedError('forbidden', 'Only the list owner can remove places.', { status: 403 });
      }
      const { rowCount } = await client.query(
        'DELETE FROM saved_list_items WHERE id = $1 AND list_id = $2',
        [itemId, listId],
      );
      if (!rowCount) {
        throw new SavedError('not_found', 'That place is not in this list.', { status: 404 });
      }
    });
    await touch(listId);
    return { ok: true };
  }

  // Suggest a place to someone else's list. The owner adds places directly;
  // for them the suggestion flow does not exist.
  async function suggest(viewer, rawListId, rawBody) {
    const listId = parseId(rawListId);
    const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const place = model.validatePlace(body.place);
    const message = model.validateMessage(body.message);
    const { rows } = await pool.query('SELECT * FROM saved_lists WHERE id = $1', [listId]);
    const row = rows[0];
    if (!row || !model.canView(viewer, toList(row))) {
      throw new SavedError('not_found', 'That list does not exist.', { status: 404 });
    }
    if (model.isOwner(viewer, toList(row))) {
      throw new SavedError('forbidden', 'You can add places to your own list directly.', { status: 403 });
    }
    const { rows: inserted } = await pool.query(
      `INSERT INTO saved_list_suggestions (list_id, from_id, from_username, message, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [listId, viewer.id, viewer.username, message, JSON.stringify(place)],
    );
    return toSuggestion(inserted[0]);
  }

  // Accept or reject. Accept inserts the item and updates the suggestion in
  // ONE transaction, so a double tap or a retried request can neither
  // double-insert nor decide twice; the UNIQUE constraint is the backstop
  // for a place the owner already added by hand.
  async function decideSuggestion(viewer, rawId, decision) {
    const id = parseId(rawId, 'That suggestion does not exist.');
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    return tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM saved_list_suggestions WHERE id = $1 FOR UPDATE', [id]);
      const s = rows[0];
      if (!s) {
        throw new SavedError('not_found', 'That suggestion does not exist.', { status: 404 });
      }
      const { rows: listRows } = await client.query('SELECT * FROM saved_lists WHERE id = $1 FOR UPDATE', [s.list_id]);
      const list = listRows[0];
      if (!list || !model.canView(viewer, toList(list))) {
        throw new SavedError('not_found', 'That suggestion does not exist.', { status: 404 });
      }
      if (!model.canWrite(viewer, toList(list))) {
        throw new SavedError('forbidden', 'Only the list owner can decide suggestions.', { status: 403 });
      }
      if (s.status !== 'pending') {
        throw new SavedError('already_decided', 'That suggestion has already been decided.', { status: 409 });
      }
      let item = null;
      if (status === 'accepted') {
        const place = model.validatePlace(s.payload);
        const { rows: insertedItems } = await client.query(
          `INSERT INTO saved_list_items
             (list_id, place_key, place_name, place_address, place_kind, place_provider, lat, lng, note, source, added_by_id, added_by_username)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,'suggestion',$9,$10)
           ON CONFLICT (list_id, place_key) DO NOTHING
           RETURNING *`,
          [
            s.list_id,
            model.placeKeyOf(place),
            place.name, place.address, place.kind, place.provider, place.lat, place.lng,
            s.from_id, s.from_username,
          ],
        );
        if (!insertedItems[0]) {
          // Roll the whole decision back: the suggestion stays pending and
          // the owner sees the honest "already in this list" answer.
          throw new SavedError('already_in_list', 'This place is already in the list.', { status: 409 });
        }
        item = toItem(insertedItems[0]);
      }
      const { rows: decided } = await client.query(
        `UPDATE saved_list_suggestions SET status = $2, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, status],
      );
      await touch(s.list_id, client);
      return { suggestion: toSuggestion(decided[0]), item };
    });
  }

  // Read one item's list first, then apply the same visibility predicate to
  // it — comments are reachable only through a list the viewer can see.
  async function readItemRow(db, viewer, rawItemId, { key = null } = {}) {
    const itemId = parseId(rawItemId, 'That place is not in this list.');
    const { rows } = await db.query(
      `SELECT i.*, l.owner_id, l.visibility, l.share_token
         FROM saved_list_items i JOIN saved_lists l ON l.id = i.list_id
        WHERE i.id = $1`,
      [itemId],
    );
    const row = rows[0];
    if (!row || !model.canView(viewer, toList({ ...row, id: row.list_id, ownerId: row.owner_id }), { key })) {
      throw new SavedError('not_found', 'That place is not in this list.', { status: 404 });
    }
    return row;
  }

  async function listComments(viewer, rawItemId, { key = null } = {}) {
    const row = await readItemRow(pool, viewer, rawItemId, { key });
    const { rows } = await pool.query(
      'SELECT * FROM saved_item_comments WHERE item_id = $1 ORDER BY created_at, id',
      [row.id],
    );
    return { items: rows.map(toComment) };
  }

  async function addComment(viewer, rawItemId, rawBody, { key = null } = {}) {
    const body = model.validateCommentBody(rawBody && rawBody.body);
    const row = await readItemRow(pool, viewer, rawItemId, { key });
    const { rows } = await pool.query(
      `INSERT INTO saved_item_comments (item_id, list_id, author_id, author_username, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [row.id, row.list_id, viewer.id, viewer.username, body],
    );
    return toComment(rows[0]);
  }

  // The author can delete their own comment; the list owner can delete any
  // comment on their list. Anyone else: not found if they cannot even see
  // the list, forbidden if they can.
  async function deleteComment(viewer, rawCommentId) {
    const commentId = parseId(rawCommentId, 'That comment does not exist.');
    await tx(async (client) => {
      const { rows } = await client.query(
        `SELECT c.*, l.owner_id, l.visibility, l.share_token
           FROM saved_item_comments c JOIN saved_lists l ON l.id = c.list_id
          WHERE c.id = $1 FOR UPDATE`,
        [commentId],
      );
      const row = rows[0];
      if (!row) {
        throw new SavedError('not_found', 'That comment does not exist.', { status: 404 });
      }
      const list = toList({ id: row.list_id, owner_id: row.owner_id, visibility: row.visibility, share_token: row.share_token });
      if (!model.canView(viewer, list)) {
        throw new SavedError('not_found', 'That comment does not exist.', { status: 404 });
      }
      if (String(row.author_id) !== String(viewer.id) && !model.isOwner(viewer, list)) {
        throw new SavedError('forbidden', 'Only the author or the list owner can delete a comment.', { status: 403 });
      }
      await client.query('DELETE FROM saved_item_comments WHERE id = $1', [commentId]);
    });
    return { ok: true };
  }

  // A list's directory position follows its latest change, so an item added
  // to a public list moves it up. Called inside the write's transaction when
  // one is open.
  async function touch(listId, client = null) {
    const db = client || pool;
    await db.query('UPDATE saved_lists SET updated_at = now() WHERE id = $1', [listId]);
  }

  // Staging only (the caller gates it on IS_STAGING). Obviously fake lists
  // by fake owners, with snapshot places marked "Staging demo", so every
  // surface — Your lists is NOT among them — has something to show. Never
  // attributed to whoever opens the preview. Fixed ids keep it idempotent.
  async function seedStaging() {
    const demo = [
      {
        id: 900001, owner: 'staging-demo-user-1', name: 'Staging demo: Bakeries of Berlin', emoji: '🥐',
        visibility: 'public', age: '6 days',
        items: [
          { id: 900101, name: 'Staging demo: Corner Bakery', address: 'Kastanienallee, Berlin', lat: 52.5386, lng: 13.4108, note: 'Staging demo note: try the rye loaf before 10am.', age: '6 days' },
          { id: 900102, name: 'Staging demo: Kastanienallee Espresso', address: 'Kastanienallee, Berlin', lat: 52.5301, lng: 13.4019, age: '5 days' },
        ],
        comments: [
          { id: 900301, item: 900101, author: 'staging-demo-user-3', body: 'Staging demo comment: the almond croissant is the one to get.', age: '4 days' },
        ],
        suggestions: [
          { id: 900201, status: 'pending', from: 'staging-demo-user-3', message: 'Staging demo suggestion message: the sourdough counter two streets over.', place: { name: 'Staging demo: Sourdough Counter', lat: 52.532, lng: 13.399, address: ' Oderberger Straße, Berlin', kind: 'poi', provider: 'photon' }, age: '2 days' },
          { id: 900202, status: 'accepted', from: 'staging-demo-user-2', message: null, place: { name: 'Staging demo: Kastanienallee Espresso', lat: 52.5301, lng: 13.4019, address: 'Kastanienallee, Berlin', kind: 'poi', provider: 'photon' }, age: '3 days' },
        ],
      },
      {
        id: 900002, owner: 'staging-demo-user-2', name: 'Staging demo: Lisbon viewpoints', emoji: '🌅',
        visibility: 'public', age: '10 days',
        items: [
          { id: 900103, name: 'Staging demo: Miradouro de São Pedro de Alcântara', address: 'Bairro Alto, Lisbon', lat: 38.7169, lng: -9.1462, age: '10 days' },
          { id: 900104, name: 'Staging demo: Santa Luzia terrace', address: 'Alfama, Lisbon', lat: 38.7131, lng: -9.1307, age: '9 days' },
        ],
        comments: [
          { id: 900302, item: 900103, author: 'staging-demo-user-1', body: 'Staging demo comment: best at sunset.', age: '8 days' },
        ],
        suggestions: [
          { id: 900203, status: 'rejected', from: 'staging-demo-user-1', message: null, place: { name: 'Staging demo: Rooftop bar viewpoint', lat: 38.7108, lng: -9.1447, kind: 'poi', provider: 'photon' }, age: '5 days' },
        ],
      },
      {
        id: 900003, owner: 'staging-demo-user-1', name: 'Staging demo: Tokyo coffee', emoji: '☕',
        visibility: 'public', age: '3 days',
        items: [
          { id: 900105, name: 'Staging demo: Shimokitazawa coffee stand', address: 'Shimokitazawa, Tokyo', lat: 35.6614, lng: 139.6679, age: '3 days' },
        ],
        comments: [],
        suggestions: [],
      },
      {
        id: 900004, owner: 'staging-demo-user-2', name: 'Staging demo: Coastal walks', emoji: '🌊',
        visibility: 'public', age: '20 days',
        items: [
          { id: 900106, name: 'Staging demo: Bondi to Coogee lookout', address: 'Sydney', lat: -33.8913, lng: 151.2767, age: '20 days' },
        ],
        comments: [],
        suggestions: [],
      },
      {
        // The negative case: private by construction, so it must never
        // appear in the public directory or answer any other viewer.
        id: 900005, owner: 'staging-demo-user-2', name: 'Staging demo: Private shortlist', emoji: '🔒',
        visibility: 'private', age: '2 days',
        items: [
          { id: 900107, name: 'Staging demo: Hidden ramen bar', address: 'Golden Gai, Tokyo', lat: 35.6933, lng: 139.7033, age: '2 days' },
        ],
        comments: [],
        suggestions: [],
      },
    ];

    for (const list of demo) {
      const { rows } = await pool.query(
        `INSERT INTO saved_lists (id, owner_id, owner_username, name, emoji, visibility, created_at, updated_at)
         VALUES ($1, $2, $2, $3, $4, $5, now() - $6::interval, now() - $6::interval)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [list.id, list.owner, list.name, list.emoji, list.visibility, list.age],
      );
      if (!rows[0]) continue;
      for (const item of list.items) {
        await pool.query(
          `INSERT INTO saved_list_items
             (id, list_id, place_key, place_name, place_address, place_kind, place_provider, lat, lng, note, source, added_by_id, added_by_username, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'photon', $7, $8, $9, 'owner', $10, $10, now() - $11::interval)
           ON CONFLICT (id) DO NOTHING`,
          [
            item.id, list.id, `coord:${item.lat.toFixed(5)},${item.lng.toFixed(5)}`,
            item.name, item.address, item.kind || 'poi', item.lat, item.lng, item.note || null,
            list.owner, item.age,
          ],
        );
      }
      for (const comment of list.comments) {
        await pool.query(
          `INSERT INTO saved_item_comments (id, item_id, list_id, author_id, author_username, body, created_at)
           VALUES ($1, $2, $3, $4, $4, $5, now() - $6::interval)
           ON CONFLICT (id) DO NOTHING`,
          [comment.id, comment.item, list.id, comment.author, comment.body, comment.age],
        );
      }
      for (const s of list.suggestions) {
        await pool.query(
          `INSERT INTO saved_list_suggestions (id, list_id, from_id, from_username, message, payload, status, created_at, decided_at)
           VALUES ($1, $2, $3, $3, $4, $5::jsonb, $6, now() - $7::interval, CASE WHEN $6 = 'pending' THEN NULL ELSE now() - $7::interval END)
           ON CONFLICT (id) DO NOTHING`,
          [s.id, list.id, s.from, s.message, JSON.stringify({ ...s.place, address: (s.place.address || '').trim() || null }), s.status, s.age],
        );
      }
    }
  }

  return {
    migrate,
    seedStaging,
    listMine,
    listPublic,
    getDetail,
    create,
    update,
    remove,
    addItem,
    updateItem,
    removeItem,
    suggest,
    decideSuggestion,
    listComments,
    addComment,
    deleteComment,
  };
}

module.exports = { createStore, SCHEMA_SQL };
