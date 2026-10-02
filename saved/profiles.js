// Profile read model — the person's own contributions, proposals and votes,
// read from the Community tables the existing store already owns.
//
// Phase 7 does NOT touch Phase 5's logic: contribution counts are a
// read-only aggregate over the same tables the community feed already reads,
// and the proposals and votes are the existing API shapes. The only rule
// applied here is the one community/model.js already spells out — a draft is
// visible to its author only — which, for the caller's OWN profile, means
// their own drafts are included and nobody else's rows ever are.
'use strict';

const model = require('../community/model');

// The statuses that count as a contribution to the map. A draft is not one:
// nothing has been shared with the community yet.
const CONTRIBUTED_STATUSES = model.PUBLIC_STATUSES;

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

const LIST_ORDER = 'p.updated_at DESC, p.id DESC';
const LIMIT = 50;

function toProposalSummary(row) {
  const up = Number(row.votes_up || 0);
  const down = Number(row.votes_down || 0);
  return {
    id: String(row.id),
    title: row.title,
    description: row.description,
    category: row.category,
    categoryLabel: model.categoryLabel(row.category),
    status: row.status,
    statusLabel: model.statusLabel(row.status),
    location:
      row.lat == null
        ? null
        : { name: row.location_name, lat: Number(row.lat), lng: Number(row.lng) },
    votes: { up, down, score: up - down },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
    statusChangedAt: iso(row.status_changed_at),
    myVote: row.my_vote == null ? 0 : Number(row.my_vote),
  };
}

// One SQL shape for both the person's proposals and their votes: the same
// per-proposal tally the community feed computes, plus the caller's own vote.
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

function createProfiles({ pool }) {
  async function contributionCounts(userId) {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE author_id = $1)::int AS proposals,
         count(*) FILTER (WHERE author_id = $1 AND status IN (${CONTRIBUTED_STATUSES.map(
           (_, i) => `$${i + 2}`,
         ).join(',')}))::int AS published,
         count(*) FILTER (WHERE author_id = $1 AND status = 'implemented')::int AS implemented
       FROM proposals`,
      [userId, ...CONTRIBUTED_STATUSES],
    );
    const r = rows[0] || {};
    return {
      proposals: Number(r.proposals || 0),
      published: Number(r.published || 0),
      implemented: Number(r.implemented || 0),
    };
  }

  async function voteCounts(userId) {
    const { rows } = await pool.query(
      `SELECT
         count(*)::int AS votes,
         count(*) FILTER (WHERE v.value = 1)::int AS up,
         count(*) FILTER (WHERE v.value = -1)::int AS down
       FROM proposal_votes v WHERE v.user_id = $1`,
      [userId],
    );
    const r = rows[0] || {};
    return { votes: Number(r.votes || 0), up: Number(r.up || 0), down: Number(r.down || 0) };
  }

  // The caller's own proposals, drafts included (they are the author, which
  // is exactly the community model's rule for who may see a draft).
  async function listProposals(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM (${SELECT_SQL}) p WHERE p.author_id = $2 ORDER BY ${LIST_ORDER} LIMIT $3`,
      [userId, userId, LIMIT],
    );
    return rows.map(toProposalSummary);
  }

  // Proposals the caller has voted on, with their own vote. Drafts are
  // excluded: a vote implies a published proposal, and a draft's author
  // cannot vote on it anyway.
  async function listVotes(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM (${SELECT_SQL}) p
        WHERE p.my_vote IS NOT NULL AND p.status <> 'draft'
        ORDER BY p.updated_at DESC, p.id DESC LIMIT $2`,
      [userId, LIMIT],
    );
    return rows.map((row) => ({ ...toProposalSummary(row), myVote: Number(row.my_vote) }));
  }

  async function overview(userId) {
    const [contributions, votes, proposals, voted] = await Promise.all([
      contributionCounts(userId),
      voteCounts(userId),
      listProposals(userId),
      listVotes(userId),
    ]);
    return { contributions, votes, proposals, voted };
  }

  return { overview, contributionCounts, voteCounts, listProposals, listVotes };
}

module.exports = { createProfiles, CONTRIBUTED_STATUSES };
