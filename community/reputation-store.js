// Reputation store — the append-only ledger behind Phase 12I's reputation
// system, and the listener that awards from the committed events the
// community and report stores already publish (community/policies.js).
//
// Totals are NEVER stored as counters: a person's reputation is always
// SUM(points) over their rows on read, the same discipline the vote and
// reaction tallies follow. Idempotency is a database fact: the partial unique
// index on (user_id, event_type, target_id) absorbs any repeated delivery —
// a retry, a re-emit, an accept → reopen → accept loop — so a double award
// is impossible by construction. A reversal is pinned to the one penalty row
// it reverses by its own unique index, so an appeal can never be
// double-reversed.
//
// The listener runs after the store's transaction has committed, exactly as
// policies.js documents. A crash in that window loses one award rather than
// duplicating one; that is the fail-closed direction, and it is accepted.
'use strict';

const model = require('./reputation-model');

const EVENT_CHECK = model.EVENT_TYPES.map((e) => `'${e}'`).join(',');

// One table, staging:private: a reputation row records what one named person
// did.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reputation_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (${EVENT_CHECK})),
  target_type TEXT,
  target_id BIGINT,
  points SMALLINT NOT NULL,
  reverses_event_id BIGINT REFERENCES reputation_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reputation_events_idem_idx
  ON reputation_events (user_id, event_type, target_id) WHERE target_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reputation_events_reverses_idx
  ON reputation_events (reverses_event_id) WHERE reverses_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reputation_events_user_idx
  ON reputation_events (user_id, created_at);
COMMENT ON TABLE reputation_events IS 'staging:private';
`;

function createReputationStore({ pool }) {
  async function migrate() {
    await pool.query(SCHEMA_SQL);
  }

  // Insert one ledger row, or nothing when the idempotency key has already
  // been used. The points come from the model's catalog, never from the
  // caller; targetType likewise. Resolves { awarded: true, id, points } for
  // a fresh row and { awarded: false } for a repeat.
  async function award({ userId, eventType, targetId, reversesEventId = null }) {
    if (!model.isKnownEvent(eventType)) {
      throw new Error(`Unknown reputation event: ${eventType}`);
    }
    if (userId == null || String(userId) === '') {
      throw new Error('A reputation award needs the user it belongs to.');
    }
    const def = model.EVENTS[eventType];
    if (targetId == null || String(targetId) === '') {
      throw new Error(`Reputation event ${eventType} needs its ${def.targetType} target id.`);
    }
    const { rows } = await pool.query(
      `INSERT INTO reputation_events (user_id, event_type, target_type, target_id, points, reverses_event_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id, points`,
      [String(userId), eventType, def.targetType, String(targetId), def.points, reversesEventId],
    );
    return rows[0]
      ? { awarded: true, id: String(rows[0].id), points: rows[0].points }
      : { awarded: false };
  }

  // A person's total and display level, computed on every read. The level is
  // a label, not a gate.
  async function totalFor(userId) {
    const { rows } = await pool.query(
      'SELECT COALESCE(SUM(points), 0)::int AS total FROM reputation_events WHERE user_id = $1',
      [String(userId)],
    );
    const total = rows[0].total;
    return { total, level: model.levelFor(total) };
  }

  // Award from the committed community events. Registered once on the shared
  // policies registry — server.js passes the same registry to the proposal
  // and report stores, so report events are heard too. policies.emit awaits
  // its listeners and logs a failure without undoing the write, so a
  // reputation problem can never break a proposal or report response.
  function register(policies) {
    for (const event of ['proposal.created', 'proposal.status_changed', 'report.status_changed']) {
      policies.on(event, (payload) => {
        const a = model.awardForCommunityEvent(event, payload);
        if (!a) return null;
        return award(a);
      });
    }
  }

  return { migrate, award, totalFor, register };
}

module.exports = { createReputationStore, SCHEMA_SQL };
