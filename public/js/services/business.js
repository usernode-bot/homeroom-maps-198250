// Business service — the browser half of the business API (Phase 12J).
//
// Every call goes to the server; nothing on this side decides who owns what.
// The server answers with the viewer-scoped permission flags
// (viewer.canClaim, viewer.canEdit, …) computed from the database, so the
// client only renders them.
//
// Place-state shape (from business/store.js GET /api/business/place/:id):
//   { placeId,
//     profile: { id, placeId, owner: { username }, status, statusLabel, name,
//                address, category, lat, lng, description, phone, website,
//                hours, verifiedAt, viewer: { isOwner, canEdit,
//                editBlockedReason, canFlag, flagBlockedReason, canModerate,
//                canViewAudit } } | null,
//     myClaim: claim | null,
//     viewer: { signedIn, canClaim, claimBlockedReason } }
//
// Claim shape: { id, placeId, place: { name, address, category, lat, lng },
//   status, statusLabel, decisionReason, decisionNote, decidedBy?, createdAt,
//   expiresAt?, daysLeft?, evidenceCount, viewer: { isClaimant, canWithdraw } }
// The claimant's own view never carries contactValue or evidence URLs: only
// the reviewer queue (fetchQueue) answers with those.
import { apiGet, apiSend } from '../api.js';

// Limits, statuses and the viewer's role. Cached for the session; a failure
// is not cached, so the next call retries.
let metaPromise = null;
export function fetchMeta() {
  if (!metaPromise) {
    metaPromise = apiGet('/api/business/meta').catch((err) => {
      metaPromise = null;
      throw err;
    });
  }
  return metaPromise;
}

// Everything the place page's Business section needs, in one read.
export function getPlaceState(placeId) {
  return apiGet(`/api/business/place/${encodeURIComponent(placeId)}`);
}

// Submit a claim for a place. `claim` is { place: {id,name,address,category,lat,lng},
// contactValue, evidence: [{url, contentType}] }.
export function submitClaim(placeId, claim) {
  return apiSend('POST', `/api/business/place/${encodeURIComponent(placeId)}/claim`, claim);
}

export function withdrawClaim(id) {
  return apiSend('POST', `/api/business/claims/${encodeURIComponent(id)}/withdraw`);
}

export function decideClaim(id, decision) {
  return apiSend('POST', `/api/business/claims/${encodeURIComponent(id)}/decision`, decision);
}

// The dashboard's one read: the viewer's own claims and businesses.
export function listMine() {
  return apiGet('/api/business/mine');
}

// The reviewer queue. `view` is pending | superseded | all.
export function fetchQueue({ view = 'pending', offset = 0 } = {}) {
  const q = new URLSearchParams({ view, offset: String(offset) });
  return apiGet(`/api/business/queue?${q.toString()}`);
}

export function getProfile(id) {
  return apiGet(`/api/business/profiles/${encodeURIComponent(id)}`);
}

// `patch` is { name?, address?, category?, description?, phone?, website?, hours? }.
export function updateProfile(id, patch) {
  return apiSend('PATCH', `/api/business/profiles/${encodeURIComponent(id)}`, patch);
}

// `status` is active | suspended.
export function moderateProfile(id, status, note = null) {
  return apiSend('POST', `/api/business/profiles/${encodeURIComponent(id)}/moderate`, { status, note });
}

export function flagProfile(id, reason = null) {
  return apiSend('POST', `/api/business/profiles/${encodeURIComponent(id)}/flag`, { reason });
}
