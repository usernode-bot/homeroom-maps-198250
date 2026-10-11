// Sharing store — the location-sharing schema and every query behind it.
//
// The privacy rules come from model.js; this module enforces the
// authorization ones against the database. Identity-scoped SQL is the whole
// access model: every read and write of a session carries the caller's id in
// the statement itself, a row belonging to another person is reported as
// not_found (404, never 403) so existence is never leaked, and there is no
// query that returns a session by id alone.
//
// Minimal retention is structural: exactly one current fix per session,
// overwritten in place — there is no history table. Ending a session (stop
// or expiry) erases its location in the SAME statement that ends it, so no
// interleaving request can observe an ended session that still holds a
// position. Ended rows are purged about a day after expiry.
//
// Both tables are staging:private: they hold named people's location data,
// exactly the category the platform conventions mark private, so staging
// starts with them empty (the demo state is client-side canned data; nothing
// here seeds the visitor).
'use strict';

const model = require('./model');
const { SharingError } = model;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sharing_sessions (
  id BIGSERIAL PRIMARY KEY,
  sharer_id TEXT NOT NULL,
  sharer_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_accuracy DOUBLE PRECISION,
  last_fix_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_reason IS NULL OR ended_reason IN ('stopped', 'expired')),
  CHECK ((last_lat IS NULL) = (last_lng IS NULL) AND (last_lng IS NULL) = (last_fix_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sharing_sessions_sharer_active
  ON sharing_sessions (sharer_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS sharing_sessions_expires_idx ON sharing_sessions (expires_at);
COMMENT ON TABLE sharing_sessions IS 'staging:private';

CREATE TABLE IF NOT EXISTS sharing_recipients (
  session_id BIGINT NOT NULL REFERENCES sharing_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  recipient_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_viewed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX IF NOT EXISTS sharing_recipients_user_idx ON sharing_recipients (user_id);
COMMENT ON TABLE sharing_recipients IS 'staging:private';
`;

function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// The one stored fix, or null. The three columns are nulled together, so a
// half-written fix cannot exist.
function fixOf(row) {
  if (row.last_fix_at == null || row.last_lat == null || row.last_lng == null) return null;
  return {
    lat: Number(row.last_lat),
    lng: Number(row.last_lng),
    accuracy: row.last_accuracy == null ? null : Number(row.last_accuracy),
    updatedAt: iso(row.last_fix_at),
  };
}

function durationMinutesOf(row) {
  return Math.max(1, Math.round((new Date(row.expires_at) - new Date(row.created_at)) / 60000));
}

function sessionApi(row, recipientRows) {
  return {
    id: String(row.id),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    durationMinutes: durationMinutesOf(row),
    lastFix: fixOf(row),
    recipients: recipientRows.map((r) => ({
      userId: String(r.user_id),
      username: r.recipient_username,
      ...(r.last_viewed_at ? { lastViewedAt: iso(r.last_viewed_at) } : {}),
    })),
  };
}

function createSharingStore({ pool }) {
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

  // Lazy expiry: an overdue session is ended and its location erased in one
  // statement. The honest end time is the scheduled one, expires_at.
  async function expireOverdue(client = pool) {
    await client.query(
      `UPDATE sharing_sessions
          SET ended_at = expires_at, ended_reason = 'expired',
              last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_fix_at = NULL,
              updated_at = now()
        WHERE ended_at IS NULL AND expires_at <= now()`,
    );
  }

  // Lazy purge: ended sessions keep no location already; their rows (and the
  // "ended" feedback they carry) are removed about a day after expiry.
  async function purgeExpired(client = pool) {
    await client.query(
      `DELETE FROM sharing_sessions WHERE expires_at < now() - interval '24 hours'`,
    );
  }

  async function maintain() {
    await expireOverdue();
    await purgeExpired();
  }

  // Create the session and its recipient rows in one transaction. The
  // recipients arrive already resolved and roster-validated (routes.js owns
  // that); creation fixes both the list and the expiry permanently. The
  // one-active-per-sharer partial unique index is the database-level guard:
  // a second active session is a 409, not a silent replacement.
  async function createSession(viewer, { expiresAt, recipients }) {
    try {
      await tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO sharing_sessions (sharer_id, sharer_username, expires_at)
           VALUES ($1, $2, $3) RETURNING *`,
          [viewer.id, viewer.username, expiresAt],
        );
        const session = rows[0];
        for (const recipient of recipients) {
          await client.query(
            `INSERT INTO sharing_recipients (session_id, user_id, recipient_username)
             VALUES ($1, $2, $3)`,
            [session.id, recipient.userId, recipient.username],
          );
        }
      });
      return await activeSessionOf(viewer);
    } catch (err) {
      if (err && err.code === '23505') {
        throw new SharingError(
          'conflict',
          'You are already sharing your location.',
          { status: 409 },
        );
      }
      throw err;
    }
  }

  async function recipientsOf(sessionId) {
    const { rows } = await pool.query(
      `SELECT * FROM sharing_recipients WHERE session_id = $1 ORDER BY created_at, user_id`,
      [sessionId],
    );
    return rows;
  }

  async function activeSessionOf(viewer) {
    const { rows } = await pool.query(
      `SELECT * FROM sharing_sessions
        WHERE sharer_id = $1 AND ended_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1`,
      [viewer.id],
    );
    if (!rows[0]) return null;
    return sessionApi(rows[0], await recipientsOf(rows[0].id));
  }

  // The owner's own active session — scoped to the caller's id in the SQL
  // itself, so nobody else's session is ever readable here.
  async function getMine(viewer) {
    await maintain();
    return { session: await activeSessionOf(viewer) };
  }

  const notFound = () => new SharingError('not_found', 'That share does not exist.', { status: 404 });

  // The owner posts one position fix. A single conditional UPDATE carries
  // every check — id, owner, still active, not expired — so there is no
  // check-then-act window: a fix racing a stop either commits first (it was
  // shared while the session was live, and the stop that follows erases it)
  // or updates zero rows and answers session_ended. Zero rows is classified
  // with one follow-up SELECT: not the caller's session → 404; theirs but
  // already over → 409. Both bodies carry no session data.
  async function updateLocation(viewer, rawId, fix) {
    const id = model.parseId(rawId);
    const { rows } = await pool.query(
      `UPDATE sharing_sessions
          SET last_lat = $3, last_lng = $4, last_accuracy = $5,
              last_fix_at = now(), updated_at = now()
        WHERE id = $1 AND sharer_id = $2 AND ended_at IS NULL AND expires_at > now()
        RETURNING last_fix_at`,
      [id, viewer.id, fix.lat, fix.lng, fix.accuracy],
    );
    if (rows.length) {
      return { ok: true, lastFixAt: iso(rows[0].last_fix_at) };
    }
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM sharing_sessions WHERE id = $1 AND sharer_id = $2',
      [id, viewer.id],
    );
    if (!existing.length) throw notFound();
    throw new SharingError('session_ended', 'That share has already ended.', { status: 409 });
  }

  // Stop now: ending the session and erasing its location are THE SAME
  // statement, so revocation is immediate and atomic even under concurrent
  // requests — no observer can see an ended session that still holds a
  // position. Already-stopped own session → idempotent success; someone
  // else's session → 404.
  async function stop(viewer, rawId) {
    const id = model.parseId(rawId);
    const { rowCount } = await pool.query(
      `UPDATE sharing_sessions
          SET ended_at = now(), ended_reason = 'stopped',
              last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_fix_at = NULL,
              updated_at = now()
        WHERE id = $1 AND sharer_id = $2 AND ended_at IS NULL`,
      [id, viewer.id],
    );
    if (rowCount === 1) return undefined;
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM sharing_sessions WHERE id = $1 AND sharer_id = $2',
      [id, viewer.id],
    );
    if (!existing.length) throw notFound();
    return undefined; // already stopped: idempotent
  }

  // The recipient's view: only sessions the caller's OWN recipient row
  // matches, never dismissed, still active, not yet expired — all in the one
  // query, so a stopped or expired session cannot appear and an in-flight
  // update cannot resurrect one. The fix age is computed server-side so the
  // client never derives freshness from a local clock. The caller's
  // last_viewed_at ("seen" transparency) is updated in the same call,
  // throttled to once a minute.
  async function listIncoming(viewer) {
    await maintain();
    const { rows } = await pool.query(
      `SELECT s.*,
              r.last_viewed_at AS my_last_viewed,
              GREATEST(0, EXTRACT(EPOCH FROM (now() - s.last_fix_at)))::int AS fix_age_seconds
         FROM sharing_recipients r
         JOIN sharing_sessions s ON s.id = r.session_id
        WHERE r.user_id = $1
          AND r.dismissed_at IS NULL
          AND s.ended_at IS NULL
          AND s.expires_at > now()
        ORDER BY s.id`,
      [viewer.id],
    );
    await pool.query(
      `UPDATE sharing_recipients
          SET last_viewed_at = now()
        WHERE user_id = $1
          AND session_id = ANY($2::bigint[])
          AND (last_viewed_at IS NULL OR last_viewed_at < now() - interval '1 minute')`,
      [viewer.id, rows.map((r) => r.id)],
    );
    return {
      shares: rows.map((row) => ({
        id: String(row.id),
        sharer: { username: row.sharer_username },
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
        lastFix: fixOf(row),
        fixAgeSeconds: row.fix_age_seconds == null ? null : Number(row.fix_age_seconds),
      })),
    };
  }

  // Dismiss: the recipient silences a session for themselves, on their own
  // row only. Idempotent; not a party to the session → 404.
  async function dismiss(viewer, rawId) {
    const id = model.parseId(rawId);
    const { rowCount } = await pool.query(
      `UPDATE sharing_recipients SET dismissed_at = now()
        WHERE session_id = $1 AND user_id = $2 AND dismissed_at IS NULL`,
      [id, viewer.id],
    );
    if (rowCount === 1) return { dismissed: true };
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM sharing_recipients WHERE session_id = $1 AND user_id = $2',
      [id, viewer.id],
    );
    if (!existing.length) throw notFound();
    return { dismissed: true };
  }

  return {
    migrate,
    maintain,
    createSession,
    getMine,
    updateLocation,
    stop,
    listIncoming,
    dismiss,
  };
}

module.exports = { createSharingStore, SCHEMA_SQL };
