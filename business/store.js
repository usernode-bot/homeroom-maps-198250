// Business store — claims, verified profiles, revisions, audit events and
// flags in Postgres (Phase 12J).
//
// The Phase 12 counterpart of community/store.js: the rules come from
// business/model.js and this module only enforces them against the database,
// inside transactions, so a rule can never be bypassed by a race. The two
// rules with teeth here:
//
//   - Verification is a reviewer decision and nothing else. The only code
//     path that sets status='verified' is decideClaim's guarded
//     UPDATE ... WHERE status='pending' (or 'superseded'), executed for a
//     configured reviewer. The 30-day pending expiry moves a claim to
//     'withdrawn', never to verified.
//   - Duplicate claims are a database fact: a partial unique index allows at
//     most ONE PENDING claim per place (and per user and place). A lost race
//     surfaces as a typed 409, with the loser's claim kept as 'superseded'
//     for the reviewer. Verified claims are guarded by the profile row's own
//     UNIQUE place_id instead, so suspending a profile frees the place.
//
// Place identity is the search stack's own id (search/normalize.js), carried
// as a soft reference exactly like saved places: no business_places table,
// no second place model, and the display strings the searcher saw are
// snapshotted on the claim row.
'use strict';

const model = require('./model');
const { BusinessError } = model;

// Idempotent schema, applied on every boot.
//
// `business_profiles` is PUBLIC: a verified business profile is public
// content, like a place's own data — anyone opening the place sees it, and
// the owner attribution shows the public username only. The other four tables
// are staging:private: a claim row carries a contact value and evidence
// links, a revision row is the profile's edit history, an event row is the
// audit trail, and a flag row records who accused a profile. A private child
// with a foreign key to the public parent is allowed under the platform's
// FK rule.
//
// No table here has a foreign key FROM the places stack and none is
// referenced by one: the place link is the soft place_id string, so a place
// provider change or a re-search never orphans business rows.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS business_profiles (
  id BIGSERIAL PRIMARY KEY,
  place_id TEXT NOT NULL UNIQUE CHECK (place_id <> '' AND length(place_id) <= 255),
  owner_user_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  address TEXT CHECK (address IS NULL OR length(address) <= 300),
  category TEXT CHECK (category IS NULL OR length(category) <= 80),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  website TEXT CHECK (website IS NULL OR length(website) <= 300),
  hours TEXT CHECK (hours IS NULL OR length(hours) <= 2000),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_profiles_owner_idx
  ON business_profiles (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS business_profiles_status_idx ON business_profiles (status);

CREATE TABLE IF NOT EXISTS business_claims (
  id BIGSERIAL PRIMARY KEY,
  place_id TEXT NOT NULL CHECK (place_id <> '' AND length(place_id) <= 255),
  place_name TEXT NOT NULL CHECK (length(place_name) BETWEEN 1 AND 200),
  place_address TEXT CHECK (place_address IS NULL OR length(place_address) <= 300),
  place_category TEXT CHECK (place_category IS NULL OR length(place_category) <= 80),
  place_lat DOUBLE PRECISION,
  place_lng DOUBLE PRECISION,
  CHECK ((place_lat IS NULL) = (place_lng IS NULL)),
  claimant_user_id TEXT NOT NULL,
  claimant_username TEXT NOT NULL,
  contact_value TEXT NOT NULL CHECK (length(contact_value) BETWEEN 1 AND 200),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','rejected','withdrawn','superseded')),
  decision_reason TEXT
    CHECK (decision_reason IS NULL OR decision_reason IN
      ('insufficient_evidence','not_your_business','duplicate_place','contact_unreachable','abuse')),
  decision_note TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most ONE pending claim per place: the second claimant loses the race and
-- their claim is recorded as superseded, never pending beside another. A
-- VERIFIED claim does not hold this index: the profile row it created (UNIQUE
-- place_id) is the source of truth, and once a reviewer suspends that profile
-- the place is claimable again while the old claim stays as history.
CREATE UNIQUE INDEX IF NOT EXISTS business_claims_place_pending_uniq
  ON business_claims (place_id) WHERE status = 'pending';
-- At most one PENDING claim per person per place: a double tap or a retried
-- request can never stack two pending claims by the same claimant.
CREATE UNIQUE INDEX IF NOT EXISTS business_claims_user_place_pending_uniq
  ON business_claims (claimant_user_id, place_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS business_claims_queue_idx ON business_claims (status, expires_at);
CREATE INDEX IF NOT EXISTS business_claims_claimant_idx
  ON business_claims (claimant_user_id, created_at DESC);
COMMENT ON TABLE business_claims IS 'staging:private';

CREATE TABLE IF NOT EXISTS business_profile_revisions (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  data JSONB NOT NULL,
  editor_user_id TEXT NOT NULL,
  editor_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, seq)
);
COMMENT ON TABLE business_profile_revisions IS 'staging:private';

CREATE TABLE IF NOT EXISTS business_profile_events (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT REFERENCES business_profiles(id) ON DELETE CASCADE,
  claim_id BIGINT,
  event_type TEXT NOT NULL CHECK (event_type IN
    ('claim_submitted','claim_withdrawn','claim_expired','claim_superseded',
     'claim_verified','claim_rejected','profile_created','ownership_transferred',
     'profile_edited','profile_suspended','profile_reinstated','profile_flagged')),
  actor_user_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  -- Redacted by rule: counts and reason codes only, never contact values or
  -- evidence URLs (they live on the private claim row they belong to).
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_profile_events_profile_idx
  ON business_profile_events (profile_id, created_at);
CREATE INDEX IF NOT EXISTS business_profile_events_claim_idx
  ON business_profile_events (claim_id);
COMMENT ON TABLE business_profile_events IS 'staging:private';

CREATE TABLE IF NOT EXISTS business_flags (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  flagger_user_id TEXT NOT NULL,
  flagger_username TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, flagger_user_id)
);
COMMENT ON TABLE business_flags IS 'staging:private';
`;

// Rollback: the same five tables, dropped leaf-first. Exported so an operator
// (or a test) can undo the migration without guessing the dependency order.
const ROLLBACK_SQL = `
DROP TABLE IF EXISTS business_flags;
DROP TABLE IF EXISTS business_profile_events;
DROP TABLE IF EXISTS business_profile_revisions;
DROP TABLE IF EXISTS business_claims;
DROP TABLE IF EXISTS business_profiles;
`;

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

// The row as the rules see it (camelCase, ids as strings).
function toProfile(row) {
  return {
    id: String(row.id),
    placeId: row.place_id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    status: row.status,
    name: row.name,
    address: row.address,
    category: row.category,
    lat: row.lat,
    lng: row.lng,
  };
}

function toClaim(row) {
  return {
    id: String(row.id),
    placeId: row.place_id,
    place: {
      name: row.place_name,
      address: row.place_address,
      category: row.place_category,
      lat: row.place_lat,
      lng: row.place_lng,
    },
    claimantUserId: row.claimant_user_id,
    claimantUsername: row.claimant_username,
    status: row.status,
    decisionReason: row.decision_reason,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

// The public profile shape. Deliberately NO owner_user_id: the public payload
// names the owner by username only, so a profile can never leak the platform
// id behind it.
function profileApi(row, viewer) {
  const profile = toProfile(row);
  const canEdit = model.canEditProfile(viewer, profile);
  return {
    id: profile.id,
    placeId: profile.placeId,
    owner: { username: profile.ownerUsername },
    status: profile.status,
    statusLabel: model.profileStatusLabel(profile.status),
    name: row.name,
    address: row.address,
    category: row.category,
    lat: row.lat,
    lng: row.lng,
    description: row.description,
    phone: row.phone,
    website: row.website,
    hours: row.hours,
    verifiedAt: iso(row.verified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    viewer: {
      isOwner: model.isOwner(viewer, profile),
      canEdit,
      editBlockedReason: canEdit ? null : model.editBlockReason(viewer, profile),
      canFlag: model.canFlag(viewer, profile),
      flagBlockedReason: model.canFlag(viewer, profile) ? null : model.flagBlockReason(viewer, profile),
      canModerate: model.canModerate(viewer),
      canViewAudit: model.canViewAudit(viewer, profile),
    },
  };
}

// The claim shape a NON-reviewer sees — the claimant themself included.
// contact_value and evidence URLs never leave the reviewer path: the
// claimant's own view shows what they need to understand the decision, and
// nothing more.
function claimApi(row, viewer) {
  const claim = toClaim(row);
  const mine = model.isClaimant(viewer, claim);
  return {
    id: claim.id,
    placeId: claim.placeId,
    place: {
      name: claim.place.name,
      address: claim.place.address,
      category: claim.place.category,
      lat: claim.place.lat,
      lng: claim.place.lng,
    },
    ...(mine ? { claimant: { username: claim.claimantUsername } } : {}),
    status: claim.status,
    statusLabel: model.claimStatusLabel(claim.status),
    decisionReason: claim.decisionReason,
    decisionNote: claim.decisionNote,
    decidedBy: mine || (viewer && viewer.reviewer) ? claim.decidedBy : null,
    createdAt: iso(row.created_at),
    decidedAt: iso(row.decided_at),
    expiresAt: claim.status === 'pending' ? iso(row.expires_at) : null,
    daysLeft: model.daysLeft(claim),
    evidenceCount: Array.isArray(row.evidence) ? row.evidence.length : 0,
    viewer: {
      isClaimant: mine,
      canWithdraw: mine && claim.status === 'pending',
    },
  };
}

// The reviewer's shape: everything needed to actually decide, including the
// contact value and the evidence links. Only the queue and the decision
// response use it.
function claimReviewApi(row) {
  const claim = toClaim(row);
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  return {
    ...claimApi(row, { id: claim.claimantUserId, reviewer: true }),
    claimant: { username: claim.claimantUsername },
    contactValue: row.contact_value,
    evidence: evidence.map((e) => (typeof e === 'string' ? { url: e } : e)),
    viewer: {
      isClaimant: true,
      canWithdraw: false,
      transitions: claim.status === 'pending'
        ? ['verified', 'rejected']
        : claim.status === 'superseded' ? ['verified'] : [],
    },
  };
}

function createBusinessStore({ pool, platformOrigin = '' }) {
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

  // The 30-day pending expiry, applied wherever claim state is read or
  // decided. A pending claim past its expiry becomes WITHDRAWN — never
  // verified, never rejected — and the expiry event records it. Idempotent:
  // an already-expired claim no longer matches the WHERE clause.
  async function expireDue(db) {
    const { rows } = await db.query(
      `UPDATE business_claims
          SET status = 'withdrawn', decided_at = now(), decided_by = 'system',
              decision_note = 'Expired after 30 days without a review', updated_at = now()
        WHERE status = 'pending' AND expires_at < now()
        RETURNING id, place_id, claimant_user_id, claimant_username`,
    );
    for (const row of rows) {
      await db.query(
        `INSERT INTO business_profile_events (claim_id, event_type, actor_user_id, actor_username, detail)
         VALUES ($1, 'claim_expired', 'system', 'system', '{}'::jsonb)`,
        [row.id],
      );
    }
    return rows.length;
  }

  // Record one audit event. `detail` is redacted by rule: counts and reason
  // codes only, never a contact value or an evidence URL.
  async function recordEvent(db, { profileId = null, claimId = null, type, viewer, detail = {} }) {
    await db.query(
      `INSERT INTO business_profile_events (profile_id, claim_id, event_type, actor_user_id, actor_username, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [profileId, claimId, type, viewer.id, viewer.username, JSON.stringify(detail)],
    );
  }

  async function readProfileRow(db, id) {
    const { rows } = await db.query('SELECT * FROM business_profiles WHERE id = $1', [id]);
    if (!rows[0]) {
      throw new BusinessError('not_found', 'That business profile does not exist.', { status: 404 });
    }
    return rows[0];
  }

  async function readClaimRow(db, id) {
    const { rows } = await db.query('SELECT * FROM business_claims WHERE id = $1', [id]);
    if (!rows[0]) {
      throw new BusinessError('not_found', 'That claim does not exist.', { status: 404 });
    }
    return rows[0];
  }

  // Everything the place page needs to render its Business section, in one
  // read: the verified profile (if any), the viewer's own claim (if any),
  // and the server-computed claim permission. No other person's claim data
  // crosses this boundary — other people's pending claims surface only as
  // the honest "someone is already claiming this place" reason.
  async function getForPlace(viewer, rawPlaceId) {
    const placeId = String(rawPlaceId || '').slice(0, model.LIMITS.placeIdMax);
    if (!placeId) {
      throw new BusinessError('invalid_query', 'A place id is required.');
    }
    await expireDue(pool);
    const [profileRows, activeRows, myRows, pendingCountRows, rejectionRows] = await Promise.all([
      pool.query('SELECT * FROM business_profiles WHERE place_id = $1', [placeId]),
      pool.query(
        `SELECT id, claimant_user_id, status FROM business_claims
          WHERE place_id = $1 AND status IN ('pending','verified') ORDER BY id DESC LIMIT 1`,
        [placeId],
      ),
      pool.query(
        `SELECT * FROM business_claims WHERE place_id = $1 AND claimant_user_id = $2
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [placeId, viewer.id],
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM business_claims
          WHERE claimant_user_id = $1 AND status = 'pending'`,
        [viewer.id],
      ),
      pool.query(
        `SELECT max(decided_at) AS at FROM business_claims
          WHERE place_id = $1 AND claimant_user_id = $2 AND status = 'rejected'`,
        [placeId, viewer.id],
      ),
    ]);
    const profileRow = profileRows.rows[0] || null;
    const activeRow = activeRows.rows[0] || null;
    const myRow = myRows.rows[0] || null;
    const ctx = {
      profile: profileRow ? toProfile(profileRow) : null,
      activeClaim: activeRow || null,
      myPending: Boolean(myRow && myRow.status === 'pending'),
      myPendingCount: pendingCountRows.rows[0].n,
      lastRejectionAt: rejectionRows.rows[0].at ? new Date(rejectionRows.rows[0].at) : null,
      now: new Date(),
    };
    return {
      placeId,
      profile: profileRow ? profileApi(profileRow, viewer) : null,
      myClaim: myRow ? claimApi(myRow, viewer) : null,
      viewer: {
        signedIn: Boolean(viewer),
        canClaim: model.canClaim(viewer, ctx),
        claimBlockedReason: model.canClaim(viewer, ctx) ? null : model.claimBlockReason(viewer, ctx),
      },
    };
  }

  // Insert one claim row in a given state; shared by the pending insert and
  // the superseded record of a losing attempt.
  async function insertClaim(db, { place, viewer, contactValue, evidence, status }) {
    const { rows } = await db.query(
      `INSERT INTO business_claims
         (place_id, place_name, place_address, place_category, place_lat, place_lng,
          claimant_user_id, claimant_username, contact_value, evidence, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11, now() + make_interval(days => $12::int))
       RETURNING id`,
      [
        place.id, place.name, place.address, place.category, place.lat, place.lng,
        viewer.id, viewer.username, contactValue, JSON.stringify(evidence),
        status, model.LIMITS.pendingExpiryDays,
      ],
    );
    return String(rows[0].id);
  }

  // Submit a claim. The abuse guards fire in order, and the place-level
  // uniqueness is enforced twice: by the pre-check for a readable message,
  // and by the partial unique index against a true race (caught below).
  async function submitClaim(viewer, body) {
    const input = model.validateClaim(body, { platformOrigin });
    const { place, contactValue, evidence } = input;
    // The honest domain error wins over the rate-limit message: someone at
    // the pending-claims cap should hear that, not "try again later". The
    // bucket still gates everything else (a flood of fresh place ids), and
    // the cap is re-checked inside the transaction against races.
    const { rows: capRows } = await pool.query(
      `SELECT count(*)::int AS n FROM business_claims
        WHERE claimant_user_id = $1 AND status = 'pending'`,
      [viewer.id],
    );
    if (capRows[0].n >= model.LIMITS.pendingClaimsPerUser) {
      throw new BusinessError(
        'claims_limit',
        `You already have ${model.LIMITS.pendingClaimsPerUser} claims waiting for review. Withdraw one or wait for a decision.`,
        { status: 429 },
      );
    }
    const bucket = claimBucket(viewer.id);
    if (!bucket.tryTake()) {
      throw new BusinessError('rate_limited', 'Too many claims right now. Try again in a little while.', { status: 429 });
    }
    const outcome = await tx(async (client) => {
      await expireDue(client);
      // Only an ACTIVE profile holds the place. A suspended one does not
      // (a reviewer suspended it, and a new claimant may apply; verifying
      // the new claim transfers ownership and reinstates the profile).
      const { rows: profileRows } = await client.query(
        "SELECT id FROM business_profiles WHERE place_id = $1 AND status = 'active'",
        [place.id],
      );
      if (profileRows[0]) {
        throw new BusinessError('not_claimable', 'This place already has a verified business profile.', { status: 409 });
      }
      const { rows: activeRows } = await client.query(
        `SELECT id, claimant_user_id FROM business_claims
          WHERE place_id = $1 AND status = 'pending' LIMIT 1`,
        [place.id],
      );
      if (activeRows[0]) {
        if (String(activeRows[0].claimant_user_id) === String(viewer.id)) {
          return { conflict: 'self' };
        }
        // The losing attempt is still recorded — as superseded, never
        // pending beside the winner — so a reviewer can see who tried for
        // the same place and decide both.
        const supersededId = await insertClaim(client, {
          place, viewer, contactValue, evidence, status: 'superseded',
        });
        await recordEvent(client, {
          claimId: supersededId,
          type: 'claim_superseded',
          viewer,
          detail: {},
        });
        return { conflict: 'other' };
      }
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM business_claims
          WHERE claimant_user_id = $1 AND status = 'pending'`,
        [viewer.id],
      );
      if (countRows[0].n >= model.LIMITS.pendingClaimsPerUser) {
        throw new BusinessError(
          'claims_limit',
          `You already have ${model.LIMITS.pendingClaimsPerUser} claims waiting for review. Withdraw one or wait for a decision.`,
          { status: 429 },
        );
      }
      const { rows: rejectRows } = await client.query(
        `SELECT max(decided_at) AS at FROM business_claims
          WHERE place_id = $1 AND claimant_user_id = $2 AND status = 'rejected'`,
        [place.id, viewer.id],
      );
      const lastRejectionAt = rejectRows[0].at ? new Date(rejectRows[0].at) : null;
      if (lastRejectionAt) {
        const until = lastRejectionAt.getTime() + model.LIMITS.coolDownDays * 24 * 3600 * 1000;
        if (Date.now() < until) {
          throw new BusinessError(
            'cool_down',
            `Your last claim for this place was rejected. You can claim it again ${model.LIMITS.coolDownDays} days after the rejection.`,
            { status: 429 },
          );
        }
      }
      try {
        const newId = await insertClaim(client, {
          place, viewer, contactValue, evidence, status: 'pending',
        });
        await recordEvent(client, {
          claimId: newId,
          type: 'claim_submitted',
          viewer,
          detail: { evidenceCount: evidence.length },
        });
        return { ok: newId };
      } catch (err) {
        // The partial unique indexes are the last line of defence against a
        // race (two claimants at once, or a double submit). Map each to its
        // honest typed error.
        if (err && err.code === '23505') {
          if (String(err.constraint || '').includes('user_place_pending')) {
            return { conflict: 'self' };
          }
          // A true race: this transaction is aborted and will roll back, so
          // the superseded record of the losing attempt is written in its
          // own transaction below, after the rollback.
          return { race: 'other' };
        }
        throw err;
      }
    });
    if (outcome.race) {
      await tx(async (client) => {
        const supersededId = await insertClaim(client, {
          place, viewer, contactValue, evidence, status: 'superseded',
        });
        await recordEvent(client, {
          claimId: supersededId,
          type: 'claim_superseded',
          viewer,
          detail: {},
        });
      });
      // The race lost: answer the same 409 the readable pre-check would have.
      outcome.conflict = 'other';
    }
    if (outcome.conflict) {
      throw new BusinessError(
        'claim_conflict',
        outcome.conflict === 'self'
          ? 'You already have a claim pending for this place.'
          : 'Someone else already has an active claim on this place. A reviewer can look at both claims.',
        { status: 409 },
      );
    }
    const { rows } = await pool.query('SELECT * FROM business_claims WHERE id = $1', [outcome.ok]);
    return claimApi(rows[0], viewer);
  }

  // The claimant withdraws their own pending claim. Nothing else may move a
  // claim to withdrawn (the 30-day expiry is the store's own move).
  async function withdrawClaim(viewer, rawId) {
    const id = parseId(rawId);
    await tx(async (client) => {
      const row = await readClaimRow(client, id);
      const claim = toClaim(row);
      if (!model.isClaimant(viewer, claim)) {
        throw new BusinessError('forbidden', 'Only the claimant can withdraw this claim.', { status: 403 });
      }
      if (claim.status !== 'pending') {
        throw new BusinessError(
          'invalid_transition',
          `A claim that is ${model.claimStatusLabel(claim.status)} can no longer be withdrawn.`,
          { status: 409 },
        );
      }
      await client.query(
        `UPDATE business_claims SET status = 'withdrawn', decided_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id],
      );
      await recordEvent(client, { claimId: id, type: 'claim_withdrawn', viewer, detail: {} });
    });
    const { rows } = await pool.query('SELECT * FROM business_claims WHERE id = $1', [id]);
    return claimApi(rows[0], viewer);
  }

  // The reviewer's decision — the ONLY path to verified. One transaction
  // covers the whole outcome: the guarded claim update, the profile upsert,
  // the seq-0 revision, and the audit events. A rejected decision needs no
  // profile work; the cool-down is derived from decided_at on read.
  async function decideClaim(viewer, rawId, body) {
    const id = parseId(rawId);
    const decision = model.validateDecision(body);
    if (!model.canModerate(viewer)) {
      throw new BusinessError('forbidden', 'Only business reviewers can decide claims.', { status: 403 });
    }
    const out = await tx(async (client) => {
      await expireDue(client);
      const row = await readClaimRow(client, id);
      const claim = toClaim(row);
      let placeHasActiveClaim = false;
      if (decision.status === 'verified' && claim.status === 'superseded') {
        const { rows } = await client.query(
          `SELECT id FROM business_claims
            WHERE place_id = $1 AND status IN ('pending','verified') AND id <> $2 LIMIT 1`,
          [claim.placeId, id],
        );
        placeHasActiveClaim = Boolean(rows[0]);
      }
      model.assertDecision(viewer, claim, decision.status, { placeHasActiveClaim });
      const { rowCount } = await client.query(
        `UPDATE business_claims
            SET status = $2, decision_reason = $3, decision_note = $4,
                decided_by = $5, decided_at = now(), updated_at = now()
          WHERE id = $1 AND status = $6`,
        [
          id, decision.status, decision.reason, decision.note, viewer.username, claim.status,
        ],
      );
      if (!rowCount) {
        // The claim moved under us (expired, withdrawn). Re-read for the
        // honest reason.
        const fresh = await readClaimRow(client, id);
        throw new BusinessError(
          'claim_conflict',
          `The claim is ${model.claimStatusLabel(fresh.status)} now, so it can no longer be decided.`,
          { status: 409 },
        );
      }
      let profileId = null;
      if (decision.status === 'verified') {
        // Upsert the profile: a first verification creates it (with its
        // seq-0 revision), a superseded-claim verification transfers
        // ownership of the existing one. Both are audited.
        const { rows: upsertRows } = await client.query(
          `INSERT INTO business_profiles
             (place_id, owner_user_id, owner_username, name, address, category, lat, lng)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (place_id) DO UPDATE
             SET owner_user_id = EXCLUDED.owner_user_id,
                 owner_username = EXCLUDED.owner_username,
                 status = 'active',
                 verified_at = now(),
                 updated_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
          [
            claim.placeId, claim.claimantUserId, claim.claimantUsername,
            claim.place.name, claim.place.address, claim.place.category,
            claim.place.lat, claim.place.lng,
          ],
        );
        profileId = String(upsertRows[0].id);
        const created = upsertRows[0].inserted;
        if (created) {
          await client.query(
            `INSERT INTO business_profile_revisions (profile_id, seq, data, editor_user_id, editor_username)
             VALUES ($1, 0, $2::jsonb, $3, $4)`,
            [
              profileId,
              JSON.stringify({
                name: claim.place.name,
                address: claim.place.address,
                category: claim.place.category,
                description: null,
                phone: null,
                website: null,
                hours: null,
              }),
              claim.claimantUserId, claim.claimantUsername,
            ],
          );
          await recordEvent(client, {
            profileId, claimId: id, type: 'profile_created', viewer, detail: {},
          });
        } else {
          await recordEvent(client, {
            profileId, claimId: id, type: 'ownership_transferred', viewer, detail: {},
          });
        }
      }
      await recordEvent(client, {
        profileId,
        claimId: id,
        type: decision.status === 'verified' ? 'claim_verified' : 'claim_rejected',
        viewer,
        detail: decision.reason ? { reason: decision.reason } : {},
      });
      return { profileId };
    });
    const { rows } = await pool.query('SELECT * FROM business_claims WHERE id = $1', [id]);
    return { claim: claimReviewApi(rows[0]), profileId: out.profileId };
  }

  // The dashboard's one read: the viewer's own claims (every status) and the
  // profiles they own. Both lists are scoped to viewer.id in the WHERE.
  async function listMine(viewer) {
    await expireDue(pool);
    const [claimRows, profileRows] = await Promise.all([
      pool.query(
        `SELECT * FROM business_claims WHERE claimant_user_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 50`,
        [viewer.id],
      ),
      pool.query(
        `SELECT * FROM business_profiles WHERE owner_user_id = $1
          ORDER BY updated_at DESC, id DESC LIMIT 50`,
        [viewer.id],
      ),
    ]);
    return {
      claims: claimRows.rows.map((row) => claimApi(row, viewer)),
      profiles: profileRows.rows.map((row) => profileApi(row, viewer)),
    };
  }

  // The reviewer's queue: pending claims, soonest-expiring first, or the
  // superseded ones awaiting an ownership swap. Non-reviewers get nothing.
  async function listQueue(viewer, rawQuery = {}) {
    if (!model.canModerate(viewer)) {
      throw new BusinessError('forbidden', 'Only business reviewers can see the review queue.', { status: 403 });
    }
    const q = model.parseQueueQuery(rawQuery);
    await expireDue(pool);
    const params = [q.limit + 1, q.offset];
    let where = "status IN ('pending','superseded')";
    if (q.view === 'pending') where = "status = 'pending'";
    else if (q.view === 'superseded') where = "status = 'superseded'";
    const { rows } = await pool.query(
      `SELECT * FROM business_claims WHERE ${where}
        ORDER BY expires_at ASC, id ASC LIMIT $1 OFFSET $2`,
      params,
    );
    const hasMore = rows.length > q.limit;
    return {
      view: q.view,
      items: rows.slice(0, q.limit).map((row) => claimReviewApi(row)),
      hasMore,
      nextOffset: hasMore ? q.offset + q.limit : null,
    };
  }

  // One profile, with its audit trail when the viewer may see it.
  async function getProfile(viewer, rawId) {
    const id = parseId(rawId);
    const row = await readProfileRow(pool, id);
    const profile = toProfile(row);
    const out = { profile: profileApi(row, viewer) };
    if (model.canViewAudit(viewer, profile)) {
      const [revRows, eventRows, flagRows] = await Promise.all([
        pool.query(
          `SELECT seq, data, editor_username, created_at FROM business_profile_revisions
            WHERE profile_id = $1 ORDER BY seq ASC`,
          [id],
        ),
        pool.query(
          `SELECT id, claim_id, event_type, actor_username, detail, created_at
             FROM business_profile_events WHERE profile_id = $1 ORDER BY created_at ASC, id ASC`,
          [id],
        ),
        pool.query(
          `SELECT flagger_username, reason, created_at FROM business_flags
            WHERE profile_id = $1 ORDER BY created_at ASC`,
          [id],
        ),
      ]);
      out.revisions = revRows.rows.map((r) => ({
        seq: r.seq,
        data: r.data,
        editor: r.editor_username,
        at: iso(r.created_at),
      }));
      out.events = eventRows.rows.map((r) => ({
        id: String(r.id),
        claimId: r.claim_id ? String(r.claim_id) : null,
        type: r.event_type,
        actor: r.actor_username,
        detail: r.detail || {},
        at: iso(r.created_at),
      }));
      out.flags = model.canModerate(viewer)
        ? flagRows.rows.map((r) => ({ flagger: r.flagger_username, reason: r.reason, at: iso(r.created_at) }))
        : undefined;
    }
    return out;
  }

  // The owner's edit. One transaction: the profile update, the next revision
  // (seq = max+1), and the audit event.
  async function updateProfile(viewer, rawId, body) {
    const id = parseId(rawId);
    const patch = model.validateProfilePatch(body);
    const result = await tx(async (client) => {
      const row = await readProfileRow(client, id);
      const profile = toProfile(row);
      if (!model.canEditProfile(viewer, profile)) {
        throw new BusinessError('forbidden', model.editBlockReason(viewer, profile), { status: 403 });
      }
      const sets = [];
      const params = [];
      for (const field of model.EDITABLE_FIELDS) {
        if (patch[field] !== undefined) {
          params.push(patch[field]);
          sets.push(`${field} = $${params.length}`);
        }
      }
      params.push(id);
      const { rows } = await client.query(
        `UPDATE business_profiles SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length}
         RETURNING *`,
        params,
      );
      const updated = rows[0];
      const { rows: seqRows } = await client.query(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM business_profile_revisions WHERE profile_id = $1',
        [id],
      );
      const seq = seqRows[0].seq;
      await client.query(
        `INSERT INTO business_profile_revisions (profile_id, seq, data, editor_user_id, editor_username)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [
          id, seq,
          JSON.stringify({
            name: updated.name,
            address: updated.address,
            category: updated.category,
            description: updated.description,
            phone: updated.phone,
            website: updated.website,
            hours: updated.hours,
          }),
          viewer.id, viewer.username,
        ],
      );
      await recordEvent(client, {
        profileId: id,
        type: 'profile_edited',
        viewer,
        detail: { fields: Object.keys(patch) },
      });
      return updated;
    });
    return profileApi(result, viewer);
  }

  // Reviewer moderation: suspend or reinstate. One transaction, audited.
  async function moderate(viewer, rawId, body) {
    const id = parseId(rawId);
    const bodyObj = body && typeof body === 'object' ? body : {};
    const status = typeof bodyObj.status === 'string' ? bodyObj.status : '';
    if (!model.PROFILE_STATUS_IDS.has(status)) {
      throw new BusinessError('invalid_status', 'A profile is active or suspended.');
    }
    const note = (typeof bodyObj.note === 'string' ? bodyObj.note.replace(/\s+/g, ' ').trim() : '') || null;
    if (note && note.length > model.LIMITS.noteMax) {
      throw new BusinessError('invalid_status', `Notes are limited to ${model.LIMITS.noteMax} characters.`, {
        fields: { note: `Notes are limited to ${model.LIMITS.noteMax} characters.` },
      });
    }
    if (!model.canModerate(viewer)) {
      throw new BusinessError('forbidden', 'Only business reviewers can moderate a profile.', { status: 403 });
    }
    const updated = await tx(async (client) => {
      const row = await readProfileRow(client, id);
      if (row.status === status) {
        throw new BusinessError(
          'invalid_transition',
          `This profile is ${model.profileStatusLabel(status)} already.`,
          { status: 409 },
        );
      }
      const { rows } = await client.query(
        'UPDATE business_profiles SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, status],
      );
      await recordEvent(client, {
        profileId: id,
        type: status === 'suspended' ? 'profile_suspended' : 'profile_reinstated',
        viewer,
        detail: note ? { note } : {},
      });
      return rows[0];
    });
    return profileApi(updated, viewer);
  }

  // Flag a profile, once per person per profile (the unique index makes that
  // a fact), never by the owner. Rate-limited like claim submission.
  async function flag(viewer, rawId, rawReason) {
    const id = parseId(rawId);
    const reason = (typeof rawReason === 'string' ? rawReason.replace(/\s+/g, ' ').trim() : '') || null;
    if (reason && reason.length > model.LIMITS.flagReasonMax) {
      throw new BusinessError('invalid_flag', `Reasons are limited to ${model.LIMITS.flagReasonMax} characters.`);
    }
    const bucket = flagBucket(viewer.id);
    if (!bucket.tryTake()) {
      throw new BusinessError('rate_limited', 'Too many flags right now. Try again in a little while.', { status: 429 });
    }
    let outcome;
    await tx(async (client) => {
      const row = await readProfileRow(client, id);
      const profile = toProfile(row);
      if (!model.canFlag(viewer, profile)) {
        throw new BusinessError('flag_not_allowed', model.flagBlockReason(viewer, profile), { status: 403 });
      }
      const { rowCount } = await client.query(
        `INSERT INTO business_flags (profile_id, flagger_user_id, flagger_username, reason)
         VALUES ($1, $2, $3, $4) ON CONFLICT (profile_id, flagger_user_id) DO NOTHING`,
        [id, viewer.id, viewer.username, reason],
      );
      outcome = rowCount ? 'flagged' : 'already';
      if (rowCount) {
        await recordEvent(client, { profileId: id, type: 'profile_flagged', viewer, detail: {} });
      }
    });
    return { outcome };
  }

  // Staging only (the caller gates it on IS_STAGING). Obviously fake claims
  // and one verified profile by fake owners, so the place section, the
  // dashboard and the review queue all have something honest to show. Fixed
  // ids keep it idempotent; place ids carry the staging-demo: prefix so they
  // can never collide with a real search-stack id; evidence is stored as a
  // tiny data-URI placeholder, never a real upload. Nothing is attributed to
  // whoever opens the preview.
  async function seedStaging() {
    const PLACEHOLDER_IMAGE =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    // One verified profile: "Staging demo: Kastanienallee corner bakery",
    // owned by a fake person, verified by a fake reviewer.
    const { rows: profileRows } = await pool.query(
      `INSERT INTO business_profiles
         (id, place_id, owner_user_id, owner_username, status, name, address, category,
          lat, lng, description, phone, website, hours, verified_at, created_at, updated_at)
       VALUES (940001, 'staging-demo:bakery-kastanienallee', 'staging-demo-owner-1', 'staging-demo-owner-1',
               'active', 'Staging demo: Kastanienallee corner bakery',
               'Kastanienallee 1, Berlin', 'Bakery', 52.5386, 13.4108,
               'Staging demo business profile. A small corner bakery with sourdough and filter coffee.',
               '+49 30 000000', 'https://staging-demo.example/bakery', 'Mon to Sat, 7:00 to 18:00',
               now() - interval '9 days', now() - interval '10 days', now() - interval '9 days')
       ON CONFLICT (id) DO NOTHING RETURNING id`,
    );
    if (profileRows[0]) {
      await pool.query(
        `INSERT INTO business_profile_revisions (profile_id, seq, data, editor_user_id, editor_username, created_at)
         VALUES (940001, 0, $1::jsonb, 'staging-demo-owner-1', 'staging-demo-owner-1', now() - interval '10 days')`,
        [
          JSON.stringify({
            name: 'Staging demo: Kastanienallee corner bakery',
            address: 'Kastanienallee 1, Berlin',
            category: 'Bakery',
            description: null,
            phone: null,
            website: null,
            hours: null,
          }),
        ],
      );
    }
    // Three claims, one per reviewer outcome the UI shows: the verified one
    // that stands behind the profile, a pending one in the queue, and a
    // rejected one (with its reason code).
    const claims = [
      [940001, 'staging-demo:bakery-kastanienallee', 'Staging demo: Kastanienallee corner bakery',
        'Kastanienallee 1, Berlin', 'Bakery', 52.5386, 13.4108, 'staging-demo-owner-1',
        'Staging demo contact: owner@example.test', 'verified', null,
        'Verified with the trade licence photo.', 'staging-demo-reviewer', '10 days', 1],
      [940002, 'staging-demo:kiosk-am-park', 'Staging demo: Kiosk am Park',
        'Am Park 12, Berlin', 'Kiosk', 52.5301, 13.4014, 'staging-demo-owner-2',
        'Staging demo contact: kiosk@example.test', 'pending', null, null, null, '2 days', 0],
      [940003, 'staging-demo:closed-cafe', 'Staging demo: Cafe am Ende',
        'Am Ende 3, Berlin', 'Cafe', 52.5412, 13.4231, 'staging-demo-owner-3',
        'Staging demo contact: cafe@example.test', 'rejected', 'insufficient_evidence',
        'The photos do not show the business at this address.', 'staging-demo-reviewer', '5 days', 0],
    ];
    for (const [id, placeId, name, address, category, lat, lng, owner, contact, status, reason, note, decidedBy, age, verified] of claims) {
      const { rows } = await pool.query(
        `INSERT INTO business_claims
           (id, place_id, place_name, place_address, place_category, place_lat, place_lng,
            claimant_user_id, claimant_username, contact_value, evidence, status,
            decision_reason, decision_note, decided_by, decided_at, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10::jsonb,$11,$12,$13,$14,
                 CASE WHEN $11 = 'pending' THEN NULL ELSE now() - interval '1 day' END,
                 now() + make_interval(days => 30), now() - $15::interval, now() - $15::interval)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, placeId, name, address, category, lat, lng, owner, contact,
          JSON.stringify([{ url: PLACEHOLDER_IMAGE, contentType: 'image/png' }]),
          status, reason, note, decidedBy, age],
      );
      if (!rows[0]) continue;
      await pool.query(
        `INSERT INTO business_profile_events (claim_id, event_type, actor_user_id, actor_username, detail, created_at)
         VALUES ($1, 'claim_submitted', $2, $2, $3::jsonb, now() - $4::interval)`,
        [id, owner, JSON.stringify({ evidenceCount: 1 }), age],
      );
      if (status !== 'pending') {
        await pool.query(
          `INSERT INTO business_profile_events (claim_id, event_type, actor_user_id, actor_username, detail, created_at)
           VALUES ($1, $2, $3, $3, $4::jsonb, now() - interval '1 day')`,
          [id, status === 'verified' ? 'claim_verified' : 'claim_rejected',
            decidedBy, JSON.stringify(reason ? { reason } : {})],
        );
      }
      if (verified) {
        await pool.query(
          `INSERT INTO business_profile_events (profile_id, claim_id, event_type, actor_user_id, actor_username, detail, created_at)
           VALUES (940001, $1, 'profile_created', $2, $2, '{}'::jsonb, now() - interval '1 day')`,
          [id, decidedBy],
        );
      }
    }
  }

  return {
    migrate,
    seedStaging,
    getForPlace,
    submitClaim,
    withdrawClaim,
    decideClaim,
    listMine,
    listQueue,
    getProfile,
    updateProfile,
    moderate,
    flag,
  };
}

// Abuse guards: small in-memory token buckets per user, the same pattern as
// search/rate-limit.js (which is per-host for outbound geocoder traffic).
// Claim submission is the expensive-to-review action; flagging is cheap but
// still bounded. The clock is injectable for tests via the factory opts.
const claimBuckets = new Map();
const flagBuckets = new Map();

function bucketFor(map, key, capacity, refillPerSecond) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new (require('../search/rate-limit').TokenBucket)({
      capacity,
      refillPerSecond,
    });
    map.set(key, bucket);
  }
  return bucket;
}

function claimBucket(userId) {
  // 3 claims immediately, then roughly one per 10 minutes.
  return bucketFor(claimBuckets, userId, 3, 1 / 600);
}

function flagBucket(userId) {
  // 5 flags immediately, then roughly one per 5 minutes.
  return bucketFor(flagBuckets, userId, 5, 1 / 300);
}

function parseId(raw) {
  if (!/^\d{1,18}$/.test(String(raw))) {
    throw new BusinessError('not_found', 'That id does not exist.', { status: 404 });
  }
  return String(raw);
}

// Test hook: clear the in-memory buckets between tests.
function resetBuckets() {
  claimBuckets.clear();
  flagBuckets.clear();
}

module.exports = { createBusinessStore, SCHEMA_SQL, ROLLBACK_SQL, resetBuckets };
