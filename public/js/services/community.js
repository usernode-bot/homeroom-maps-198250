// Community service — the browser half of the community API.
//
// Proposals and voting are real (Phase 5): every call goes to
// /api/community/* and every number on screen is what the server returned.
// Reports, contributions and discussions are later phases; their functions
// stay as clearly empty interfaces so no screen can fake them.
//
// Proposal shape (from community/store.js):
//   { id, author: { id, username }, title, description, category,
//     categoryLabel, location: { name, lat, lng } | null, attachments: [],
//     status, statusLabel, createdAt, publishedAt, statusChangedAt,
//     votes: { up, down, score }, distanceKm?,
//     viewer: { isAuthor, vote, canEdit, canVote, transitions,
//               editBlockedReason, voteBlockedReason },
//     history?: [{ from, to, toLabel, actor, at }] }
import { apiGet, apiSend } from '../api.js';
import { feedPath, voteRequest } from './community-feed.js';

let metaPromise = null;

// Categories, statuses and the viewer's role. Cached for the session; a
// failure is not cached, so the next call retries.
export function fetchMeta() {
  if (!metaPromise) {
    metaPromise = apiGet('/api/community/meta').catch((err) => {
      metaPromise = null;
      throw err;
    });
  }
  return metaPromise;
}

export function listProposals(view, { offset = 0, near = null, radiusKm = null } = {}) {
  return apiGet(feedPath(view, { offset, near, radiusKm }));
}

export function getProposal(id) {
  return apiGet(`/api/community/proposals/${encodeURIComponent(id)}`);
}

// `draft` is { title, description, category, location, attachments }.
// publish: true opens it for votes straight away; otherwise it is a draft.
export function createProposal(draft, { publish = false } = {}) {
  return apiSend('POST', '/api/community/proposals', { ...draft, publish });
}

export function updateProposal(id, patch) {
  return apiSend('PATCH', `/api/community/proposals/${encodeURIComponent(id)}`, patch);
}

export function changeStatus(id, status) {
  return apiSend('POST', `/api/community/proposals/${encodeURIComponent(id)}/status`, { status });
}

// Tap semantics live in the core: the same direction again withdraws.
// Resolves { proposal, outcome } where outcome is cast | changed | removed |
// unchanged.
export function castVote(id, currentVote, pressed) {
  const req = voteRequest(currentVote, pressed);
  const path = `/api/community/proposals/${encodeURIComponent(id)}/vote`;
  return req.method === 'DELETE' ? apiSend('DELETE', path) : apiSend('PUT', path, { value: req.value });
}

// ── later phases: interfaces only ─────────────────────────────────────────

const NOT_IMPLEMENTED = 'This community feature is not built yet.';

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
