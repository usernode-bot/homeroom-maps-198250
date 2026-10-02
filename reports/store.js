// Reports store — community reports, confirm/disagree reactions, abuse flags
// and status history in Postgres.
//
// The Phase 6 counterpart of community/store.js: the rules come from
// reports/model.js and this module only enforces them against the database,
// inside transactions, so a rule can never be bypassed by a race. Reaction
// tallies are NEVER stored as counters: every tally is aggregated from
// report_reactions on read, so the number shown is always exactly the rows
// that exist. Expiration is likewise never stored — `expired` is derived
// from expires_at on every read.
'use strict';

const model = require('./model');
const { CommunityError } = model;

// Idempotent schema, applied on every boot.
//
// `reports` and `report_status_events` are PUBLIC: a report is immediately
// public content — anyone opening the app sees the feed, just like posts or
// leaderboards — and the status history shows the same lifecycle the report
// detail shows. `report_reactions` and `report_flags` are staging:private:
// a reaction row records how a named person answered, and a flag row records
// who accused a report of abuse. A private child with a foreign key to a
// public parent (reports) is allowed under the platform's FK rule.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL
    CHECK (type IN ('traffic','accident','road_closed','construction','hazard','flood',
                    'fire','broken_road','wrong_map_data','place_closed','other')),
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  description TEXT,
  place_id TEXT,
  place_provider TEXT,
  reporter_id TEXT NOT NULL,
  reporter_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((place_id IS NULL) = (place_provider IS NULL))
);
CREATE INDEX IF NOT EXISTS reports_status_expires_idx ON reports (status, expires_at);
CREATE INDEX IF NOT EXISTS reports_reporter_idx ON reports (reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_lat_lng_idx ON reports (lat, lng);

CREATE TABLE IF NOT EXISTS report_reactions (
  report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('confirm','disagree')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);
COMMENT ON TABLE report_reactions IS 'staging:private';

CREATE TABLE IF NOT EXISTS report_flags (
  report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);
COMMENT ON TABLE report_flags IS 'staging:private';

CREATE TABLE IF NOT EXISTS report_status_events (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_status_events_report_idx
  ON report_status_events (report_id, created_at);
`;

// One row per report with its live reaction tally and the viewer's own
// reaction. $1 is always the viewer's id.
const SELECT_SQL = `
SELECT r.*,
       COALESCE(t.confirm, 0)::int AS reactions_confirm,
       COALESCE(t.disagree, 0)::int AS reactions_disagree,
       mr.value AS my_reaction
  FROM reports r
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE value = 'confirm') AS confirm,
           count(*) FILTER (WHERE value = 'disagree') AS disagree
      FROM report_reactions WHERE report_id = r.id
  ) t ON true
  LEFT JOIN report_reactions mr ON mr.report_id = r.id AND mr.user_id = $1
`;

// The "current" filter used by Recent and Nearby: everything that has NOT
// derived-expired. A rejected report keeps its standing answer, so it stays
// (its Rejected status pill says what happened). Mirrors
// model.effectiveStatus exactly: expired = now() > expires_at AND not
// rejected.
const CURRENT_SQL = `NOT (now() > r.expires_at AND r.status <> 'rejected')`;

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function parseId(raw) {
  if (!/^\d{1,18}$/.test(String(raw))) {
    throw new CommunityError('not_found', 'That report does not exist.', { status: 404 });
  }
  return String(raw);
}

// The row as the rules see it.
function toReport(row) {
  return {
    id: String(row.id),
    reporterId: row.reporter_id,
    status: row.status,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

// The API shape. `viewer` decides the permission block; nothing in it is
// guessed client-side. `effectiveStatus` carries the derived expiration so
// the client never derives it again.
function toApi(row, viewer) {
  const report = toReport(row);
  const canReact = model.canReact(viewer, report);
  const canFlag = model.canFlag(viewer, report);
  const out = {
    id: report.id,
    type: row.type,
    typeLabel: model.typeLabel(row.type),
    description: row.description,
    place: row.place_id ? { id: row.place_id, provider: row.place_provider } : null,
    lat: Number(row.lat),
    lng: Number(row.lng),
    reporter: { id: row.reporter_id, username: row.reporter_username },
    status: report.status,
    statusLabel: model.statusLabel(report.status),
    effectiveStatus: model.effectiveStatus(report),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    reactions: { confirm: row.reactions_confirm || 0, disagree: row.reactions_disagree || 0 },
    viewer: {
      isReporter: model.isReporter(viewer, report),
      reaction: row.my_reaction || null,
      canReact,
      canFlag,
      reactBlockedReason: canReact ? null : model.reactBlockReason(viewer, report),
      flagBlockedReason: canFlag ? null : model.flagBlockReason(viewer, report),
      transitions: model.allowedTransitions(viewer, report),
    },
  };
  if (row.distance_km != null) out.distanceKm = Math.round(Number(row.distance_km) * 10) / 10;
  return out;
}

function createReportsStore({ pool, policies }) {
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

  async function readRow(db, viewer, id) {
    const { rows } = await db.query(`${SELECT_SQL} WHERE r.id = $2`, [viewer.id, id]);
    const row = rows[0];
    if (!row) {
      throw new CommunityError('not_found', 'That report does not exist.', { status: 404 });
    }
    return row;
  }

  // Lock the report row for the rest of the transaction. FOR UPDATE for
  // status moves, FOR SHARE for reactions and flags: a decision can never
  // slip in beside a tally-changing tap.
  async function lockRow(client, viewer, id, mode) {
    const { rows } = await client.query(`SELECT id FROM reports WHERE id = $1 FOR ${mode}`, [id]);
    if (!rows[0]) throw new CommunityError('not_found', 'That report does not exist.', { status: 404 });
    return readRow(client, viewer, id);
  }

  async function recordStatus(client, id, from, to, viewer) {
    await client.query(
      `INSERT INTO report_status_events (report_id, from_status, to_status, actor_id, actor_username)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, from, to, viewer.id, viewer.username],
    );
  }

  async function list(viewer, rawQuery) {
    const q = model.parseFeedQuery(rawQuery);
    const params = [viewer.id];
    let where = 'true';
    let order = 'r.created_at DESC, r.id DESC';
    let from = `(${SELECT_SQL}) r`;

    if (q.view === 'mine') {
      // The reporter's own history: expired reports stay visible so the
      // reporter can see what they reported and what became of it.
      params.push(viewer.id);
      where += ` AND r.reporter_id = $${params.length}`;
      order = 'r.updated_at DESC, r.id DESC';
    } else if (q.view === 'nearby') {
      params.push(q.near.lat, q.near.lng, q.radiusKm);
      const [la, ln, r] = [params.length - 2, params.length - 1, params.length];
      from = `(SELECT s.*, 6371 * 2 * asin(sqrt(
                  power(sin(radians(s.lat - $${la}) / 2), 2) +
                  cos(radians($${la})) * cos(radians(s.lat)) *
                  power(sin(radians(s.lng - $${ln}) / 2), 2))) AS distance_km
                 FROM (${SELECT_SQL}) s) r`;
      where += ` AND ${CURRENT_SQL} AND r.distance_km <= $${r}`;
      order = 'r.distance_km ASC, r.id DESC';
    } else if (!q.includeExpired) {
      where += ` AND ${CURRENT_SQL}`;
    }

    if (q.type) {
      params.push(q.type);
      where += ` AND r.type = $${params.length}`;
    }
    if (q.placeId) {
      params.push(q.placeId);
      where += ` AND r.place_id = $${params.length}`;
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
      items: rows.slice(0, q.limit).map((row) => toApi(row, viewer)),
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
         FROM report_status_events WHERE report_id = $1 ORDER BY created_at, id`,
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
    const input = model.validateReport(body);
    const type = model.TYPES.find((t) => t.id === input.type);
    const id = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO reports (type, lat, lng, description, place_id, place_provider,
                              reporter_id, reporter_username, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending', now() + make_interval(hours => $9::int))
         RETURNING id`,
        [
          input.type,
          input.lat,
          input.lng,
          input.description,
          input.placeId,
          input.placeProvider,
          viewer.id,
          viewer.username,
          type.expiresHours,
        ],
      );
      const newId = String(rows[0].id);
      await recordStatus(client, newId, null, 'pending', viewer);
      return newId;
    });
    const out = await get(viewer, id);
    await policies.emit('report.created', { viewer, report: out });
    return out;
  }

  // Cast or change a Confirm/Disagree reaction. The (report_id, user_id)
  // primary key is what makes "one active answer per person" a database
  // fact; the conditional upsert turns a repeat of the same answer into a
  // no-op, so a double tap or a retried request can never count twice —
  // the same mechanism the proposal vote uses.
  async function setReaction(viewer, rawId, rawValue) {
    const id = parseId(rawId);
    const value = model.parseReactionValue(rawValue);
    let outcome;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'SHARE');
      const report = toReport(row);
      if (!model.canReact(viewer, report)) {
        throw new CommunityError('reaction_not_allowed', model.reactBlockReason(viewer, report), {
          status: 403,
        });
      }
      const { rows } = await client.query(
        `INSERT INTO report_reactions (report_id, user_id, value) VALUES ($1, $2, $3)
         ON CONFLICT (report_id, user_id) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
          WHERE report_reactions.value <> EXCLUDED.value
         RETURNING (xmax = 0) AS inserted`,
        [id, viewer.id, value],
      );
      outcome = rows[0] ? (rows[0].inserted ? 'cast' : 'changed') : 'unchanged';
    });
    const out = await get(viewer, id);
    if (outcome !== 'unchanged') {
      await policies.emit(`report.reaction.${outcome}`, { viewer, report: out, value });
    }
    return { report: out, outcome };
  }

  async function removeReaction(viewer, rawId) {
    const id = parseId(rawId);
    let outcome;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'SHARE');
      const report = toReport(row);
      if (!model.canReact(viewer, report)) {
        throw new CommunityError('reaction_not_allowed', model.reactBlockReason(viewer, report), {
          status: 403,
        });
      }
      const { rowCount } = await client.query(
        'DELETE FROM report_reactions WHERE report_id = $1 AND user_id = $2',
        [id, viewer.id],
      );
      outcome = rowCount ? 'removed' : 'unchanged';
    });
    const out = await get(viewer, id);
    if (outcome === 'removed') {
      await policies.emit('report.reaction.removed', { viewer, report: out });
    }
    return { report: out, outcome };
  }

  // Report abuse: once per person per report (the primary key makes that a
  // database fact), never by the reporter. Reason is optional and bounded.
  async function flag(viewer, rawId, rawReason) {
    const id = parseId(rawId);
    const reason = model.parseFlagReason(rawReason);
    let outcome;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'SHARE');
      const report = toReport(row);
      if (!model.canFlag(viewer, report)) {
        throw new CommunityError('flag_not_allowed', model.flagBlockReason(viewer, report), {
          status: 403,
        });
      }
      const { rowCount } = await client.query(
        `INSERT INTO report_flags (report_id, user_id, reason) VALUES ($1, $2, $3)
         ON CONFLICT (report_id, user_id) DO NOTHING`,
        [id, viewer.id, reason],
      );
      outcome = rowCount ? 'flagged' : 'already';
    });
    const out = await get(viewer, id);
    if (outcome === 'flagged') {
      await policies.emit('report.flagged', { viewer, report: out, reason });
    }
    return { report: out, outcome };
  }

  // Reviewer-only lifecycle moves, recorded in report_status_events.
  async function transition(viewer, rawId, to) {
    const id = parseId(rawId);
    let from;
    await tx(async (client) => {
      const row = await lockRow(client, viewer, id, 'UPDATE');
      from = row.status;
      model.assertTransition(viewer, toReport(row), to);
      await client.query(
        'UPDATE reports SET status=$2, updated_at=now() WHERE id=$1',
        [id, to],
      );
      await recordStatus(client, id, from, to, viewer);
    });
    const out = await get(viewer, id);
    await policies.emit('report.status_changed', { viewer, report: out, from, to });
    return out;
  }

  // Staging only (the caller gates it on IS_STAGING). Obviously fake reports
  // by fake reporters, with fake reactions, so every feed view and the
  // detail sheet have something to show — including one already-expired
  // report so the derived Expired state is exercised. Never attributed to
  // whoever opens the preview, and never a reaction or flag by them: their
  // own answers and their own "Mine" list start empty, exactly as in
  // production. Fixed ids keep it idempotent.
  async function seedStaging() {
    const demo = [
      // [id, type, lat, lng, description, placeRef, reporterN, status, age, steps, reactions]
      [920001, 'traffic', 52.5219, 13.4132,
        'Staging demo report. Long queue of cars at the intersection, backed up past the second light.',
        null, 1, 'pending', '2 hours', [], false],
      [920002, 'hazard', -33.8688, 151.2093,
        'Staging demo report. Loose paving slab on the footpath right where people cross.',
        null, 2, 'verified', '5 hours', ['verified'], true],
      [920003, 'wrong_map_data', 38.7223, -9.1393,
        'Staging demo report. The map shows a bus stop here that was removed last spring.',
        null, 3, 'rejected', '3 days', ['verified', 'rejected'], false],
      [920004, 'accident', 43.6626, -79.3312,
        'Staging demo report. Minor collision cleared an hour ago; traffic moving again.',
        null, 4, 'pending', '12 hours', [], false],
      [920005, 'place_closed', 35.6614, 139.6679,
        'Staging demo report. This cafe has closed down; the unit is empty.',
        ['staging-demo-place-1', 'staging-demo'], 5, 'pending', '1 day', [], false],
    ];
    for (const [id, type, lat, lng, description, place, reporterN, status, age, steps, withReactions] of demo) {
      const reporter = `staging-demo-reporter-${reporterN}`;
      const expiresHours = model.TYPES.find((t) => t.id === type).expiresHours;
      const { rows } = await pool.query(
        `INSERT INTO reports (id, type, lat, lng, description, place_id, place_provider,
                              reporter_id, reporter_username, status, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,
                 now() - $10::interval + make_interval(hours => $11::int),
                 now() - $10::interval, now() - $10::interval)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, type, lat, lng, description, place ? place[0] : null, place ? place[1] : null,
          reporter, status, age, expiresHours],
      );
      if (!rows[0]) continue;
      // A history that follows the real lifecycle: reported by the reporter,
      // then each reviewer step on the way to the seeded status, spread over
      // the report's age like the proposal seed does.
      await pool.query(
        `INSERT INTO report_status_events
           (report_id, from_status, to_status, actor_id, actor_username, created_at)
         VALUES ($1, null, 'pending', $2, $2, now() - $3::interval)`,
        [id, reporter, age],
      );
      for (let i = 0; i < steps.length; i += 1) {
        await pool.query(
          `INSERT INTO report_status_events
             (report_id, from_status, to_status, actor_id, actor_username, created_at)
           VALUES ($1, $2, $3, 'staging-demo-reviewer', 'staging-demo-reviewer',
                   now() - $4::interval * $5)`,
          [id, i === 0 ? 'pending' : 'verified', steps[i], age, (steps.length - i) / (steps.length + 1)],
        );
      }
      // The verified demo report carries a reaction split: three Confirm and
      // one Disagree, all from fake identities.
      if (withReactions) {
        for (let i = 0; i < 3; i += 1) {
          await pool.query(
            `INSERT INTO report_reactions (report_id, user_id, value) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [id, `staging-demo-confirmer-${i + 1}`, 'confirm'],
          );
        }
        await pool.query(
          `INSERT INTO report_reactions (report_id, user_id, value) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, 'staging-demo-disagreer-1', 'disagree'],
        );
      }
    }
  }

  return { migrate, seedStaging, list, get, create, setReaction, removeReaction, flag, transition };
}

module.exports = { createReportsStore, SCHEMA_SQL };