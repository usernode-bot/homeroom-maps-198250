// Community service — the browser half of the community API.
//
// Proposals and voting are real (Phase 5) and reports are real (Phase 6):
// every call goes to the server and every number on screen is what the
// server returned. Contributions and discussions are later phases; their
// functions stay as clearly empty interfaces so no screen can fake them.
//
// Proposal shape (from community/store.js):
//   { id, author: { id, username }, title, description, category,
//     categoryLabel, location: { name, lat, lng } | null, attachments: [],
//     status, statusLabel, createdAt, publishedAt, statusChangedAt,
//     votes: { up, down, score }, distanceKm?,
//     viewer: { isAuthor, vote, canEdit, canVote, transitions,
//               editBlockedReason, voteBlockedReason },
//     history?: [{ from, to, toLabel, actor, at }] }
//
// Report shape (from reports/store.js): same discipline, plus
//   { type, typeLabel, place: { id, provider } | null, lat, lng,
//     reporter: { id, username }, status, effectiveStatus, expiresAt,
//     reactions: { confirm, disagree }, distanceKm?,
//     viewer: { isReporter, reaction, canReact, canFlag, reactBlockedReason,
//               flagBlockedReason, transitions } }
// `effectiveStatus` is the server's derived expiration ('expired' when the
// window has passed and it was not rejected), so the client never derives
// it again.
import { apiGet, apiSend } from '../api.js';
import { feedPath, voteRequest } from './community-feed.js';

let metaPromise = null;
let reportsMetaPromise = null;

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

// Report types, statuses and limits. Same caching discipline as fetchMeta;
// the report form fetches this lazily, the first time it opens.
export function fetchReportsMeta() {
  if (!reportsMetaPromise) {
    reportsMetaPromise = apiGet('/api/reports/meta').catch((err) => {
      reportsMetaPromise = null;
      throw err;
    });
  }
  return reportsMetaPromise;
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

// ── reports (Phase 6) ─────────────────────────────────────────────────────

// The reports feed. `view` is recent | nearby | mine — the same paging and
// nearby-centre contract the proposal feed uses, so createFeed() drives it
// unmodified.
export function listReports(view, { offset = 0, near = null, radiusKm = null } = {}) {
  const q = new URLSearchParams();
  q.set('view', view);
  q.set('offset', String(offset));
  if (near) {
    q.set('near', `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`);
    if (radiusKm) q.set('radius', String(radiusKm));
  }
  return apiGet(`/api/reports?${q.toString()}`);
}

export function getReport(id) {
  return apiGet(`/api/reports/${encodeURIComponent(id)}`);
}

// `report` is { type, lat, lng, description?, placeId?, placeProvider? }.
// A report is public the moment it is created; there is no draft state.
export function createReport(report) {
  return apiSend('POST', '/api/reports', report);
}

// One active answer per person: confirm | disagree. Resolves
// { report, outcome } where outcome is cast | changed | removed | unchanged.
export function setReportReaction(id, value) {
  return apiSend('PUT', `/api/reports/${encodeURIComponent(id)}/reaction`, { value });
}

export function removeReportReaction(id) {
  return apiSend('DELETE', `/api/reports/${encodeURIComponent(id)}/reaction`);
}

// Report abuse, once per person per report. Reason is optional.
export function flagReport(id, reason = null) {
  return apiSend('POST', `/api/reports/${encodeURIComponent(id)}/flag`, { reason });
}

// Reviewer-only lifecycle moves: pending → verified | rejected, and
// verified → rejected.
export function changeReportStatus(id, status) {
  return apiSend('POST', `/api/reports/${encodeURIComponent(id)}/status`, { status });
}

// ── later phases: interfaces only ─────────────────────────────────────────

const NOT_IMPLEMENTED = 'This community feature is not built yet.';

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