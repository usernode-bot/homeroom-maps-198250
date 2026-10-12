// Reputation model — the closed catalog of reputation events, their points
// and the display levels. Pure rules, no I/O, exactly like community/model.js:
// the store enforces them against the database and nothing else computes them.
//
// The catalog is CLOSED: adding an event type is a spec change (Phase 12I
// §4), because every ledger row is validated against this table and a
// person's reputation is always the SUM of its points — never a stored
// counter. Points live ONLY here; the store reads them from this table so a
// caller can never supply its own.
'use strict';

const EVENTS = {
  proposal_published: { points: 2, targetType: 'proposal' },
  proposal_accepted: { points: 5, targetType: 'proposal' },
  proposal_implemented: { points: 5, targetType: 'proposal' },
  report_verified: { points: 3, targetType: 'report' },
  abuse_penalty: { points: -10, targetType: 'case' },
  abuse_penalty_reversed: { points: 10, targetType: 'case' },
};

const EVENT_TYPES = Object.keys(EVENTS);

// Display levels are labels, never gates: nothing in the app keys behaviour
// off them, so a brand-new contributor can do everything a veteran can. A
// negative total is shown as-is; it is still the 'new' level.
const LEVELS = [
  { id: 'new', min: 0 },
  { id: 'contributor', min: 10 },
  { id: 'trusted', min: 50 },
];

function isKnownEvent(eventType) {
  return Object.prototype.hasOwnProperty.call(EVENTS, eventType);
}

function pointsFor(eventType) {
  return isKnownEvent(eventType) ? EVENTS[eventType].points : null;
}

function levelFor(total) {
  let level = LEVELS[0].id;
  for (const l of LEVELS) {
    if (total >= l.min) level = l.id;
  }
  return level;
}

// Map one committed community event — the payloads the proposal and report
// stores already publish through policies.emit after their transactions — to
// the reputation event it earns, or null. Eligibility lives here: only the
// first publish and the reviewer-confirmed transitions earn anything, and
// only for the author/reporter of record as the payload carries it from the
// server's own row. Votes, reactions and flags map to nothing.
function awardForCommunityEvent(event, payload) {
  if (!payload) return null;

  if (event === 'proposal.created') {
    const p = payload.proposal;
    // Publish-at-create is a first publish; a plain draft create earns nothing.
    if (p && p.status === 'open' && p.author) {
      return { eventType: 'proposal_published', userId: p.author.id, targetType: 'proposal', targetId: p.id };
    }
    return null;
  }

  if (event === 'proposal.status_changed') {
    const p = payload.proposal;
    if (!p || !p.author) return null;
    // Publishing an existing draft. Same event and same idempotency key as
    // publish-at-create, so either path awards exactly once; a re-open from
    // under_review is NOT a publish and earns nothing.
    if (payload.to === 'open' && payload.from === 'draft') {
      return { eventType: 'proposal_published', userId: p.author.id, targetType: 'proposal', targetId: p.id };
    }
    if (payload.to === 'accepted') {
      return { eventType: 'proposal_accepted', userId: p.author.id, targetType: 'proposal', targetId: p.id };
    }
    if (payload.to === 'implemented') {
      return { eventType: 'proposal_implemented', userId: p.author.id, targetType: 'proposal', targetId: p.id };
    }
    return null;
  }

  if (event === 'report.status_changed') {
    const r = payload.report;
    if (payload.to === 'verified' && r && r.reporter) {
      return { eventType: 'report_verified', userId: r.reporter.id, targetType: 'report', targetId: r.id };
    }
    return null;
  }

  return null;
}

module.exports = { EVENTS, EVENT_TYPES, LEVELS, isKnownEvent, pointsFor, levelFor, awardForCommunityEvent };
