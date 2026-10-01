// Community store — proposals, votes and status history in Postgres.
//
// The rules come from model.js; this module only enforces them against the
// database, inside transactions, so a rule can never be bypassed by a race.
// Vote counts are NEVER stored as counters: every tally is aggregated from
// proposal_votes on read, so the number shown is always exactly the votes
// that exist.
'use strict';

const model = require('./model');
const { CommunityError } = model;

// Idempotent schema, applied on every boot. All three tables are
// staging:private: drafts are visible to their author only, and a vote row
// records how a named person voted. Staging therefore starts with them empty
// and seedStaging() fills in obviously fake rows.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proposals (
  id BIGSERIAL PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_username TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  location_name TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','under_review','accepted','rejected','implemented')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ,
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX IF NOT EXISTS proposals_status_published_idx ON proposals (status, published_at DESC);
CREATE INDEX IF NOT EXISTS proposals_author_idx ON proposals (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_lat_lng_idx ON proposals (lat, lng);
COMMENT ON TABLE proposals IS 'staging:private';

CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id BIGINT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  value SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id)
);
COMMENT ON TABLE proposal_votes IS 'staging:private';

CREATE TABLE IF NOT EXISTS proposal_status_events (
  id BIGSERIAL PRIMARY KEY,
  proposal_id BIGINT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposal_status_events_proposal_idx
  ON proposal_status_events (proposal_id, created_at);
COMMENT ON TABLE proposal_status_events IS 'staging:private';
`;

// One row per proposal with its live tally and the viewer's own vote.
// $1 is always the viewer's id.
const SELECT_SQL = `
SELECT p.*,
       COALESCE(t.up, 0)::int AS votes_up,
       COALESCE(t.down, 0)::int AS votes_down,
       mv.value AS my_vote
  FROM proposals p
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE value = 1) AS up,
           count(*) FILTER (WHERE value = -1) AS down
      FROM proposal_votes WHERE proposal_id = p.id
  ) t ON true
  LEFT JOIN proposal_votes mv ON mv.proposal_id = p.id AND mv.user_id = $1
`;

const PUBLIC_LIST = model.PUBLIC_STATUSES.map((s) => `'${s}'`).join(',');

// The status path each seeded proposal took, so its history obeys TRANSITIONS.
const SEED_PATHS = {
  open: ['open'],
  under_review: ['open', 'under_review'],
  accepted: ['open', 'under_review', 'accepted'],
  rejected: ['open', 'under_review', 'rejected'],
  implemented: ['open', 'under_review', 'accepted', 'implemented'],
};

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function parseId(raw) {
  if (!/^\d{1,18}$/.test(String(raw))) {
    throw new CommunityError('not_found', 'That proposal does not exist.', { status: 404 });
  }
  return String(raw);
}

// The row as the rules see it.
function toProposal(row) {
  return {
    id: String(row.id),
    authorId: row.author_id,
    status: row.status,
    hidden: Boolean(row.hidden_at),
    votes: { up: row.votes_up || 0, down: row.votes_down || 0 },
  };
}

// The API shape. `viewer` decides the permission block; nothing in it is
// guessed client-side.
function toApi(row, viewer) {
  const p = toProposal(row);
  const up = p.votes.up;
  const down = p.votes.down;
  const canEdit = model.canEdit(viewer, p);
  const canVote = model.canVote(viewer, p);
  const out = {
    id: p.id,
    author: { id: row.author_id, username: row.author_username },
    title: row.title,
    description: row.description,
    category: row.category,
    categoryLabel: model.categoryLabel(row.category),
    location:
      row.lat == null ? null : { name: row.location_name, lat: Number(row.lat), lng: Number(row.lng) },
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    status: row.status,
    statusLabel: model.statusLabel(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
    statusChangedAt: iso(row.status_changed_at),
    votes: { up, down, score: up - down },
    viewer: {
      isAuthor: model.isAuthor(viewer, p),
      vote: row.my_vote == null ? 0 : Number(row.my_vote),
      canEdit,
      canVote,
      transitions: model.allowedTransitions(viewer, p),
      editBlockedReason: canEdit ? null : model.editBlockReason(viewer, p),
      voteBlockedReason: canVote ? null : model.voteBlockReason(viewer, p),
    },
  };
  if (row.distance_km != null) out.distanceKm = Math.round(Number(row.distance_km) * 10) / 10;
  return out;
}

function createStore({ pool, policies, platformOrigin = '' }) {
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

  async function refuseIfGated(stage, ctx) {
    const verdict = await policies.runGates(stage, ctx);
    if (verdict) {
      throw new CommunityError(verdict.code || 'refused', verdict.message || 'This was refused.', {
        status: verdict.status || 422,
      });
    }
  }

  async function migrate() {
    await pool.query(SCHEMA_SQL);
  }

  async function readRow(db, viewer, id) {
    const { rows } = await db.query(`${SELECT_SQL} WHERE p.id = $2`, [viewer.id, id]);
    const row = rows[0];
    if (!row || !model.canView(viewer, toProposal(row))) {
      throw new CommunityError('not_found', 'That proposal does not exist.', { status: 404 });
    }
    return row;
  }

  // Lock the proposal row for the rest of the transaction. FOR UPDATE for
  // edits and status moves, FOR SHARE for votes: the two conflict, so an
  // edit can never slip in beside a first vote, nor a vote beside a decision.
  async function lockRow(client, viewer, id, mode) {
    const { rows } = await client.query(`SELECT id FROM proposals WHERE id = $1 FOR ${mode}`, [id]);
    if (!rows[0]) throw new CommunityError('not_found', 'That proposal does not exist.', { status: 404 });
    return readRow(client, viewer, id);
  }

  async function recordStatus(client, id, from, to, viewer) {
    await client.query(
      `INSERT INTO proposal_status_events (proposal_id, from_status, to_status, actor_id, actor_username)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, from, to, viewer.id, viewer.username],
    );
  }

  async function list(viewer, rawQuery) {
    const q = model.parseFeedQuery(rawQuery);
    const params = [viewer.id];
    let where = 'p.hidden_at IS NULL';
    let order = 'p.published_at DESC, p.id DESC';
    let from = `(${SELECT_SQL}) p`;

    if (q.view === 'mine') {
      params.push(viewer.id);
      where += ` AND p.author_id = $${params.length}`;
      order = 'p.updated_at DESC, p.id DESC';
    } else if (q.view === 'implemented') {
      where += ` AND p.status = 'implemented'`;
      order = 'p.status_changed_at DESC, p.id DESC';
    } else if (q.view === 'popular') {
      // Only proposals still being decided: a ranking of closed ones would
      // ask people to vote where they no longer can.
      where += ` AND p.status IN ('open','under_review')`;
      order = '(p.votes_up - p.votes_down) DESC, p.votes_up DESC, p.published_at DESC, p.id DESC';
    } else if (q.view === 'nearby') {
      params.push(q.near.lat, q.near.lng, q.radiusKm);
      const [la, ln, r] = [params.length - 2, params.length - 1, params.length];
      from = `(SELECT s.*, 6371 * 2 * asin(sqrt(
                  power(sin(radians(s.lat - $${la}) / 2), 2) +
                  cos(radians($${la})) * cos(radians(s.lat)) *
                  power(sin(radians(s.lng - $${ln}) / 2), 2))) AS distance_km
                 FROM (${SELECT_SQL}) s WHERE s.lat IS NOT NULL) p`;
      where += ` AND p.status IN (${PUBLIC_LIST}) AND p.distance_km <= $${r}`;
      order = 'p.distance_km ASC, p.id DESC';
    } else {
      where += ` AND p.status IN (${PUBLIC_LIST})`;
    }

    // One extra row tells us whether another page exists.
    params.push(q.limit + 1, q.offset);
    const { rows } = await pool.query(
      `SELECT * FROM ${from} WHERE ${where} ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const hasMore = rows.length > q.limit;
    return {
      view: q.view,
      items: rows.slice(0, q.limit).map((r) => toApi(r, viewer)),
      hasMore,
      nextOffset: hasMore ? q.offset + q.limit : null,
      ...(q.view === 'nearby' ? { near: q.near, radiusKm: q.radiusKm } : {}),
    };
  }

  async function get(viewer, rawId) {
    const id = parseId(rawId);
    const row = await readRow(pool, viewer, id);
    const { rows: events } = await pool.query(
      `SELECT from_status, to_status, actor_username, created_at
         FROM proposal_status_events WHERE proposal_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return {
      ...toApi(row, viewer),
      history: events.map((e) => ({
        from: e.from_status,
        to: e.to_status,
        toLabel: model.statusLabel(e.to_status),
        actor: e.actor_username,
        at: iso(e.created_at),
      })),
    };
  }

  async function create(viewer, body) {
    const draft = model.validateDraft(body, { platformOrigin });
    const publish = Boolean(body && body.publish);
    await refuseIfGated('create', { viewer, draft, publish });
    const id = await tx(async (client) => {
      const status = publish ? 'open' : 'draft';
      const { rows } = await client.query(
        `INSERT INTO proposals (author_id, author_username, title, description, category,
                                location_name, lat, lng, attachments, status, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10, CASE WHEN $10 = 'open' THEN now() END)
         RETURNING id`,
        [
          viewer.id,
          viewer.username,
          draft.title,
          draft.description,
          draft.category,
          draft.location ? draft.location.name : null,
          draft.location ? draft.location.lat : null,
          draft.location ? draft.location.lng : null,
          JSON.stringify(draft.attachments),
          status,
        ],
      );
      const newId = String(rows[0].id);
      await recordStatus(client, newId, null, status, viewer);
      return newId;
    });
    const out = await get(viewer, id);
    await policies.emit('proposal.created', { viewer, proposal: out });
    return out;
  }

  // Edit: the stored proposal merged with the provided fields, revalidated
  // as a whole. Allowed only where model.canEdit says so.
  async function update(viewer, rawId, body) {
    const id = parseId(rawId);
    const patch = body && typeof body === 'object' ? body : {};
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'UPDATE');
      const p = toProposal(row);
      if (!model.canEdit(viewer, p)) {
        throw new CommunityError('edit_not_allowed', model.editBlockReason(viewer, p), {
          status: model.isAuthor(viewer, p) ? 409 : 403,
        });
      }
      const merged = {
        title: 'title' in patch ? patch.title : row.title,
        description: 'description' in patch ? patch.description : row.description,
        category: 'category' in patch ? patch.category : row.category,
        location:
          'location' in patch
            ? patch.location
            : row.lat == null
              ? null
              : { name: row.location_name, lat: row.lat, lng: row.lng },
        attachments: 'attachments' in patch ? patch.attachments : row.attachments,
      };
      const draft = model.validateDraft(merged, { platformOrigin });
      await refuseIfGated('update', { viewer, proposal: toApi(row, viewer), draft });
      await client.query(
        `UPDATE proposals SET title=$2, description=$3, category=$4, location_name=$5,
                lat=$6, lng=$7, attachments=$8::jsonb, updated_at=now()
          WHERE id=$1`,
        [
          id,
          draft.title,
          draft.description,
          draft.category,
          draft.location ? draft.location.name : null,
          draft.location ? draft.location.lat : null,
          draft.location ? draft.location.lng : null,
          JSON.stringify(draft.attachments),
        ],
      );
    });
    const out = await get(viewer, id);
    await policies.emit('proposal.updated', { viewer, proposal: out });
    return out;
  }

  async function transition(viewer, rawId, to) {
    const id = parseId(rawId);
    let from;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'UPDATE');
      from = row.status;
      model.assertTransition(viewer, toProposal(row), to);
      await refuseIfGated('status', { viewer, proposal: toApi(row, viewer), to });
      await client.query(
        `UPDATE proposals
            SET status=$2, status_changed_at=now(), updated_at=now(),
                published_at = COALESCE(published_at, CASE WHEN $2 <> 'draft' THEN now() END)
          WHERE id=$1`,
        [id, to],
      );
      await recordStatus(client, id, from, to, viewer);
    });
    const out = await get(viewer, id);
    await policies.emit('proposal.status_changed', { viewer, proposal: out, from, to });
    return out;
  }

  // Cast or change a vote. The (proposal_id, user_id) primary key is what
  // makes "one active vote per person" a database fact; the conditional
  // upsert turns a repeat of the same vote into a no-op, so a double tap or
  // a retried request can never count twice.
  async function vote(viewer, rawId, rawValue) {
    const id = parseId(rawId);
    const value = model.parseVoteValue(rawValue);
    let outcome;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'SHARE');
      const p = toProposal(row);
      if (!model.canVote(viewer, p)) {
        throw new CommunityError('vote_not_allowed', model.voteBlockReason(viewer, p), {
          status: model.isAuthor(viewer, p) ? 403 : 409,
        });
      }
      await refuseIfGated('vote', { viewer, proposal: toApi(row, viewer), value });
      const { rows } = await client.query(
        `INSERT INTO proposal_votes (proposal_id, user_id, value) VALUES ($1, $2, $3)
         ON CONFLICT (proposal_id, user_id) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
          WHERE proposal_votes.value <> EXCLUDED.value
         RETURNING (xmax = 0) AS inserted`,
        [id, viewer.id, value],
      );
      outcome = rows[0] ? (rows[0].inserted ? 'cast' : 'changed') : 'unchanged';
    });
    const out = await get(viewer, id);
    if (outcome !== 'unchanged') await policies.emit(`vote.${outcome}`, { viewer, proposal: out, value });
    return { proposal: out, outcome };
  }

  async function unvote(viewer, rawId) {
    const id = parseId(rawId);
    let outcome;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'SHARE');
      const p = toProposal(row);
      if (!model.canVote(viewer, p)) {
        throw new CommunityError('vote_not_allowed', model.voteBlockReason(viewer, p), {
          status: model.isAuthor(viewer, p) ? 403 : 409,
        });
      }
      const { rowCount } = await client.query(
        'DELETE FROM proposal_votes WHERE proposal_id = $1 AND user_id = $2',
        [id, viewer.id],
      );
      outcome = rowCount ? 'removed' : 'unchanged';
    });
    const out = await get(viewer, id);
    if (outcome === 'removed') await policies.emit('vote.removed', { viewer, proposal: out });
    return { proposal: out, outcome };
  }

  // Staging only (the caller gates it on IS_STAGING). Obviously fake
  // proposals by fake authors, with fake voters, so every feed view has
  // something to show. Never attributed to whoever opens the preview, and
  // never a vote by them: their own vote and their own "Yours" list start
  // empty, exactly as in production. Fixed ids keep it idempotent.
  async function seedStaging() {
    const demo = [
      [900001, 'open', 'add_missing_place', 'Staging demo: add the corner bakery on Kastanienallee',
        'Staging demo proposal. A small bakery has been open on this corner for two years and is missing from the map.',
        'Kastanienallee, Berlin', 52.5386, 13.4108, '6 days', [1, 1, 1, -1]],
      [900002, 'open', 'update_hours', 'Staging demo: library opens at 9 on Saturdays',
        'Staging demo proposal. The listed Saturday opening time is 10:00, but the sign on the door says 09:00.',
        'Biblioteca Municipal, Lisbon', 38.7223, -9.1393, '4 days', [1]],
      [900003, 'under_review', 'correct_location', 'Staging demo: ferry pier pin is too far east',
        'Staging demo proposal. The pier marker sits about 200 m east of the actual boarding point.',
        'Circular Quay, Sydney', -33.8610, 151.2108, '10 days', [1, 1, 1, 1, 1]],
      [900004, 'accepted', 'add_landmark', 'Staging demo: add the old water tower',
        'Staging demo proposal. The brick water tower is a well known meeting point and deserves a landmark pin.',
        'Leslieville, Toronto', 43.6626, -79.3312, '20 days', [1, 1, 1, 1, -1, -1]],
      [900005, 'implemented', 'suggest_map_improvement', 'Staging demo: show cycle paths more clearly',
        'Staging demo proposal. Separated cycle paths are hard to tell apart from footpaths at city zoom levels.',
        null, null, null, '30 days', [1, 1, 1, 1, 1, 1]],
      [900006, 'rejected', 'report_wrong_information', 'Staging demo: park listed as closed',
        'Staging demo proposal. The park is marked closed for renovation, which seemed out of date.',
        'Uhuru Park, Nairobi', -1.2900, 36.8167, '15 days', [-1, -1, -1]],
      [900007, 'open', 'correct_place', 'Staging demo: cafe name is misspelled',
        'Staging demo proposal. The cafe is listed with a typo in its name.',
        'Shimokitazawa, Tokyo', 35.6614, 139.6679, '2 days', []],
    ];
    for (const [id, status, category, title, description, place, lat, lng, age, votes] of demo) {
      const author = `staging-demo-author-${id - 900000}`;
      const steps = SEED_PATHS[status];
      const { rows } = await pool.query(
        `INSERT INTO proposals (id, author_id, author_username, title, description, category,
                                location_name, lat, lng, status, created_at, updated_at,
                                published_at, status_changed_at)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9, now() - $10::interval, now() - $10::interval,
                 now() - $10::interval, now() - $10::interval * $11)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, author, title, description, category, place, lat, lng, status, age, 1 / steps.length],
      );
      if (!rows[0]) continue;
      // A history that follows the real lifecycle: published by the author,
      // then each reviewer step on the way to the seeded status.
      for (let i = 0; i < steps.length; i += 1) {
        const actor = i === 0 ? author : 'staging-demo-reviewer';
        await pool.query(
          `INSERT INTO proposal_status_events (proposal_id, from_status, to_status, actor_id, actor_username, created_at)
           VALUES ($1, $2, $3, $4, $4, now() - $5::interval * $6)`,
          [id, i === 0 ? null : steps[i - 1], steps[i], actor, age, (steps.length - i) / steps.length],
        );
      }
      for (let i = 0; i < votes.length; i += 1) {
        await pool.query(
          `INSERT INTO proposal_votes (proposal_id, user_id, value) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, `staging-demo-voter-${i + 1}`, votes[i]],
        );
      }
    }
  }

  return { migrate, seedStaging, list, get, create, update, transition, vote, unvote };
}

module.exports = { createStore, SCHEMA_SQL };
