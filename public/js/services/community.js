// Community service — INTERFACE ONLY. Phase 0 defines the contract the later
// community work plugs into; there is no backend behind any of it and no
// database table. Every function resolves a clearly empty/placeholder shape so
// a screen can be wired against a stable API without faking results.
//
// Entity shapes later stages should populate (comments only, no implementation):
//   Proposal   { id, title, body, author, status, createdAt, voteCounts }
//   Vote       { proposalId, userId, choice, createdAt }
//   Report     { id, category, location, note, author, status, createdAt }
//   Contribution { id, kind, placeId, payload, author, status, createdAt }
//   Discussion { id, topic, author, createdAt }
//   DiscussionMessage { id, discussionId, author, body, createdAt }
//
// The matching server routes (/api/community/*) currently answer 501
// not_implemented, so nothing here silently invents data.

const NOT_IMPLEMENTED = 'The community features are not built yet.';

export async function listProposals() {
  return { items: [], notImplemented: true, reason: NOT_IMPLEMENTED };
}

export async function getProposal(_id) {
  return null;
}

export async function createProposal(_draft) {
  throw new Error(NOT_IMPLEMENTED);
}

export async function listVotes(_proposalId) {
  return { items: [], notImplemented: true, reason: NOT_IMPLEMENTED };
}

export async function castVote(_proposalId, _choice) {
  throw new Error(NOT_IMPLEMENTED);
}

export async function listReports(_area) {
  return { items: [], notImplemented: true, reason: NOT_IMPLEMENTED };
}

export async function createReport(_report) {
  throw new Error(NOT_IMPLEMENTED);
}

export async function listContributions(_filters) {
  return { items: [], notImplemented: true, reason: NOT_IMPLEMENTED };
}

export async function submitContribution(_contribution) {
  throw new Error(NOT_IMPLEMENTED);
}

export async function listDiscussions(_topic) {
  return { items: [], notImplemented: true, reason: NOT_IMPLEMENTED };
}

export async function postDiscussionMessage(_topicId, _body) {
  throw new Error(NOT_IMPLEMENTED);
}
