// Business profile model — pure, I/O-free rules (Phase 12J).
//
// Everything that decides WHAT is allowed lives here: who may claim a place,
// who may edit a verified profile, who may decide claims, and what a claim or
// a profile edit may contain. store.js enforces these rules against Postgres
// inside transactions; tests/business.model.test.js drives them without a
// database. Keeping the rules in one synchronous module means the server and
// the tests can never disagree about them.
//
// Two rules matter more than anything else here:
//
//   1. Login is never proof of ownership. A claim is an application carrying
//      contact details and evidence; ONLY a reviewer's decision verifies it.
//      Nothing in this module, the store or the routes can set `verified`
//      except a reviewer's decision — there is no timer, no heuristic and no
//      auto-verify path.
//   2. Ownership is a database fact, not a request field. Every permission
//      predicate compares the viewer against state read from the database;
//      `owner_user_id` or `reviewer` sent in a request body is ignored.
'use strict';

// A typed error the routes turn into the app's standard JSON error shape.
class BusinessError extends Error {
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

// Claim lifecycle. `superseded` is the losing side of a race: when someone
// claims a place that already has an active claim, their claim is recorded as
// superseded (and they get a 409) so a reviewer can still see they tried. A
// superseded claim can be verified ONLY after the winning claim is rejected
// or withdrawn — the one audited ownership-swap path.
const CLAIM_STATUSES = [
  { id: 'pending', label: 'Pending' },
  { id: 'verified', label: 'Verified' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'superseded', label: 'Superseded' },
];
const CLAIM_STATUS_IDS = new Set(CLAIM_STATUSES.map((s) => s.id));

// Profile lifecycle. Suspension is a reviewer moderation action, not a claim
// state; a suspended profile keeps its owner and can be reinstated.
const PROFILE_STATUSES = [
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
];
const PROFILE_STATUS_IDS = new Set(PROFILE_STATUSES.map((s) => s.id));

// The lifecycle. Each allowed move names who may make it: the claim's
// `claimant`, a `reviewer`, or the `store` itself (the superseded stamp and
// the 30-day expiry, neither of which is a human decision). Note what is
// absent: nothing transitions a claim to `verified` except a reviewer.
const TRANSITIONS = {
  pending: { verified: 'reviewer', rejected: 'reviewer', withdrawn: 'claimant' },
  superseded: { verified: 'reviewer' },
  verified: {},
  rejected: {},
  withdrawn: {},
};

// Why a reviewer may reject a claim. The code is stored on the claim, shown
// to the claimant, and the only thing the audit event carries (never the
// evidence or the contact value).
const REJECT_REASONS = [
  { id: 'insufficient_evidence', label: 'Not enough evidence' },
  { id: 'not_your_business', label: 'Not your business' },
  { id: 'duplicate_place', label: 'Duplicate place' },
  { id: 'contact_unreachable', label: 'Contact could not be reached' },
  { id: 'abuse', label: 'Abuse' },
];
const REJECT_REASON_IDS = new Set(REJECT_REASONS.map((r) => r.id));

const LIMITS = {
  placeIdMax: 255,
  placeNameMax: 200,
  addressMax: 300,
  categoryMax: 80,
  descriptionMax: 1000,
  phoneMax: 40,
  websiteMax: 300,
  hoursMax: 2000,
  contactMin: 5,
  contactMax: 200,
  noteMax: 500,
  flagReasonMax: 500,
  evidenceMax: 3,
  pendingClaimsPerUser: 3,
  pendingExpiryDays: 30,
  coolDownDays: 7,
  pageDefault: 20,
  pageMax: 50,
};

// Platform-stored files have an unguessable 32-hex id under /app-files/.
// Only those URLs are accepted as evidence, so a claim can never carry an
// arbitrary third-party link dressed up as a photo of a licence.
const APP_FILE_PATH = /^\/app-files\/[0-9a-f]{32}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function claimStatusLabel(id) {
  const s = CLAIM_STATUSES.find((x) => x.id === id);
  return s ? s.label : id;
}

function profileStatusLabel(id) {
  const s = PROFILE_STATUSES.find((x) => x.id === id);
  return s ? s.label : id;
}

function isClaimStatus(id) {
  return CLAIM_STATUS_IDS.has(id);
}

// ── roles and permissions ────────────────────────────────────────────────

// `viewer` is { id, username, reviewer } — the reviewer flag is resolved by
// the caller from configuration, exactly as community/reports do. `profile`
// carries the DB row's owner_user_id and status; `claim` carries the DB row's
// claimant_user_id and status.

function isOwner(viewer, profile) {
  return Boolean(viewer && profile && String(viewer.id) === String(profile.ownerUserId));
}

function isClaimant(viewer, claim) {
  return Boolean(viewer && claim && String(viewer.id) === String(claim.claimantUserId));
}

// A place is claimable when nothing stands in the way: no ACTIVE profile (a
// suspended one lets a new claimant apply — verifying the new claim transfers
// ownership and reinstates), no pending claim by anyone (first in line wins),
// and no claim of the viewer's own already pending. A VERIFIED claim row does
// not block by itself: the profile it created is the source of truth, and
// when a reviewer suspends that profile the place is open again even though
// the old claim row remains as history. `ctx` carries the DB facts:
//   profile          the verified profile for the place, or null
//   activeClaim      the newest pending/verified claim on the place, or null
//   myPending        whether the viewer's own claim on the place is pending
//   myPendingCount   the viewer's pending claims across all places
//   lastRejectionAt  when the viewer's most recent claim on this place was
//                    rejected (Date or null)
//   now              the current time (injectable for tests)
function canClaim(viewer, ctx) {
  if (!viewer) return false;
  if (ctx.profile && ctx.profile.status === 'active') return false;
  if (ctx.myPending) return false;
  if (ctx.activeClaim && ctx.activeClaim.status === 'pending') return false;
  if (ctx.myPendingCount < LIMITS.pendingClaimsPerUser) {
    if (!ctx.lastRejectionAt) return true;
    const until = ctx.lastRejectionAt.getTime() + LIMITS.coolDownDays * 24 * 3600 * 1000;
    return (ctx.now || new Date()).getTime() >= until;
  }
  return false;
}

// Why not, in one honest sentence. Reads the same facts as canClaim; the UI
// shows it instead of a dead button.
function claimBlockReason(viewer, ctx) {
  if (!viewer) return 'Sign in to claim a business.';
  if (ctx.profile && ctx.profile.status === 'active') {
    return 'This place already has a verified business profile.';
  }
  if (ctx.myPending) return 'You already have a claim pending for this place.';
  if (ctx.activeClaim && ctx.activeClaim.status === 'pending') {
    return 'Someone else already has an active claim on this place. A reviewer can look at both claims.';
  }
  if (ctx.myPendingCount >= LIMITS.pendingClaimsPerUser) {
    return `You already have ${LIMITS.pendingClaimsPerUser} claims waiting for review. Withdraw one or wait for a decision.`;
  }
  return `Your last claim for this place was rejected. You can claim it again ${LIMITS.coolDownDays} days after the rejection.`;
}

// Only the verified owner may edit, and only while the profile is active. A
// suspended profile is frozen until a reviewer reinstates it.
function canEditProfile(viewer, profile) {
  return isOwner(viewer, profile) && profile.status === 'active';
}

function editBlockReason(viewer, profile) {
  if (!isOwner(viewer, profile)) return 'Only the verified owner can edit this profile.';
  if (profile.status === 'suspended') return 'This profile is suspended, so it cannot be edited until a reviewer reinstates it.';
  return '';
}

// Reviewer decisions. `extra` may carry { placeHasActiveClaim } — verifying a
// superseded claim needs the winner gone first. The transition table's actor
// is enforced, not just the move's existence: a reviewer cannot make a
// claimant's move (withdraw) any more than a claimant can make a reviewer's.
function canDecide(viewer, claim, to, extra = {}) {
  if (!viewer || !isClaimStatus(to)) return false;
  const by = (TRANSITIONS[claim.status] || {})[to];
  if (!by) return false;
  const actorOk = by === 'reviewer'
    ? Boolean(viewer.reviewer)
    : isClaimant(viewer, claim);
  if (!actorOk) return false;
  if (to === 'verified' && claim.status === 'superseded' && extra.placeHasActiveClaim) return false;
  return true;
}

function decideBlockReason(viewer, claim, to, extra = {}) {
  if (!viewer) return 'Sign in to decide a claim.';
  const by = (TRANSITIONS[claim.status] || {})[to];
  if (!by) {
    return `A claim that is ${claimStatusLabel(claim.status)} cannot become ${claimStatusLabel(to)}.`;
  }
  if (by === 'reviewer' && !viewer.reviewer) return 'Only business reviewers can decide claims.';
  if (by === 'claimant' && !isClaimant(viewer, claim)) {
    return 'Only the claimant can withdraw this claim.';
  }
  if (to === 'verified' && claim.status === 'superseded' && extra.placeHasActiveClaim) {
    return 'Another claim on this place is still active. Reject or wait on that one first.';
  }
  return '';
}

function canModerate(viewer) {
  return Boolean(viewer && viewer.reviewer);
}

// The audit trail (revisions and events) is for the owner and reviewers.
function canViewAudit(viewer, profile) {
  return isOwner(viewer, profile) || canModerate(viewer);
}

// Anyone signed in may flag a profile except its owner; one flag per person
// per profile (a database unique index makes that a fact).
function canFlag(viewer, profile) {
  return Boolean(viewer && profile && profile.status === 'active' && !isOwner(viewer, profile));
}

function flagBlockReason(viewer, profile) {
  if (!viewer) return 'Sign in to flag a profile.';
  if (isOwner(viewer, profile)) return 'You cannot flag your own business profile.';
  return 'This profile is suspended already.';
}

// Throws unless `viewer` may move `claim` to `to`.
function assertDecision(viewer, claim, to, extra = {}) {
  if (!isClaimStatus(to)) {
    throw new BusinessError('invalid_decision', 'That decision does not exist.');
  }
  if (!canDecide(viewer, claim, to, extra)) {
    throw new BusinessError('forbidden', decideBlockReason(viewer, claim, to, extra), { status: 403 });
  }
}

// ── validation ───────────────────────────────────────────────────────────

function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function cleanMultiline(raw) {
  return typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

// The place a claim is about. The id is the REAL search-stack id the result
// already carries (search/normalize.js — including its coordinate fallback),
// never a place this app invents; the display strings are the ones the
// searcher actually saw, snapshotted at claim time.
function validatePlaceRef(raw, fields) {
  const placeId = cleanText(raw && raw.id);
  if (!placeId) {
    fields.place = 'Open this claim from a place on the map.';
    return null;
  }
  if (placeId.length > LIMITS.placeIdMax) {
    fields.place = 'That place reference is too long.';
    return null;
  }
  const name = cleanText(raw && raw.name);
  if (!name) {
    fields.place = 'Give the place its name as shown in search.';
    return null;
  }
  if (name.length > LIMITS.placeNameMax) {
    fields.place = `Place names are limited to ${LIMITS.placeNameMax} characters.`;
    return null;
  }
  const address = cleanText(raw && raw.address) || null;
  if (address && address.length > LIMITS.addressMax) {
    fields.address = `Addresses are limited to ${LIMITS.addressMax} characters.`;
    return null;
  }
  const category = cleanText(raw && raw.category) || null;
  if (category && category.length > LIMITS.categoryMax) {
    fields.place = `Categories are limited to ${LIMITS.categoryMax} characters.`;
    return null;
  }
  let lat = null;
  let lng = null;
  const hasCoords = raw && (raw.lat != null || raw.lng != null);
  if (hasCoords) {
    lat = Number(raw.lat);
    lng = Number(raw.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      fields.place = 'The place coordinates are out of range.';
      return null;
    }
  }
  return { id: placeId, name, address, category, lat, lng };
}

// Evidence images come from the platform's storage (uploaded with the bridge,
// private visibility). Same contract as community proposal attachments.
function validateEvidence(raw, fields, { platformOrigin = '' } = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    fields.evidence = 'Evidence must be a list of photos.';
    return [];
  }
  if (raw.length > LIMITS.evidenceMax) {
    fields.evidence = `Attach at most ${LIMITS.evidenceMax} photos.`;
    return [];
  }
  const out = [];
  for (const item of raw) {
    let url;
    try {
      url = new URL(String(item && item.url));
    } catch {
      fields.evidence = 'One of the photos is not a stored image.';
      return [];
    }
    const originOk = platformOrigin ? url.origin === platformOrigin : /^https?:$/.test(url.protocol);
    if (!originOk || !APP_FILE_PATH.test(url.pathname) || url.search || url.hash) {
      fields.evidence = 'One of the photos is not a stored image.';
      return [];
    }
    const contentType = String((item && item.contentType) || '');
    if (contentType && !IMAGE_TYPES.has(contentType)) {
      fields.evidence = 'Evidence must be images.';
      return [];
    }
    out.push({
      id: url.pathname.slice('/app-files/'.length),
      url: url.origin + url.pathname,
      filename: cleanText(item.filename).slice(0, 200) || null,
      contentType: contentType || null,
    });
  }
  const ids = new Set(out.map((a) => a.id));
  if (ids.size !== out.length) {
    fields.evidence = 'The same photo is attached twice.';
    return [];
  }
  return out;
}

// Validate a claim body: the place reference, how the reviewer can reach the
// owner, and up to three evidence photos. Returns the cleaned values or
// throws a BusinessError carrying per-field messages.
function validateClaim(input, opts = {}) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  const place = validatePlaceRef(body.place, fields);
  const contactValue = cleanText(body.contactValue);
  if (contactValue.length < LIMITS.contactMin) {
    fields.contactValue = `Give a way to reach the business (at least ${LIMITS.contactMin} characters).`;
  } else if (contactValue.length > LIMITS.contactMax) {
    fields.contactValue = `Contact details are limited to ${LIMITS.contactMax} characters.`;
  }
  const evidence = validateEvidence(body.evidence, fields, opts);
  if (Object.keys(fields).length) {
    throw new BusinessError('invalid_claim', 'Some details need fixing.', { fields });
  }
  return { place, contactValue, evidence };
}

// Validate a reviewer's decision. A rejection names a reason code; a note is
// optional on both outcomes.
function validateDecision(input) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  const status = typeof body.status === 'string' ? body.status : '';
  if (!isClaimStatus(status) || (status !== 'verified' && status !== 'rejected')) {
    fields.status = 'A decision is verified or rejected.';
  }
  let reason = null;
  if (status === 'rejected') {
    reason = cleanText(body.reason);
    if (!REJECT_REASON_IDS.has(reason)) {
      fields.reason = 'Choose a reason for the rejection.';
    }
  }
  const note = cleanMultiline(body.note) || null;
  if (note && note.length > LIMITS.noteMax) {
    fields.note = `Notes are limited to ${LIMITS.noteMax} characters.`;
  }
  if (Object.keys(fields).length) {
    throw new BusinessError('invalid_decision', 'The decision needs fixing.', { fields });
  }
  return { status, reason, note };
}

const EDITABLE_FIELDS = ['name', 'address', 'category', 'description', 'phone', 'website', 'hours'];

function isHttpUrl(raw) {
  return /^https?:\/\/\S+$/i.test(raw) && raw.length <= LIMITS.websiteMax;
}

// Validate an owner's profile edit. Every field is optional; at least one
// must change. Returns the cleaned patch keyed by the changed fields.
function validateProfilePatch(input) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  const patch = {};

  if (body.name !== undefined) {
    const name = cleanText(body.name);
    if (!name) fields.name = 'Give the business its name.';
    else if (name.length > LIMITS.placeNameMax) fields.name = `Names are limited to ${LIMITS.placeNameMax} characters.`;
    else patch.name = name;
  }
  if (body.address !== undefined) {
    const address = cleanText(body.address);
    if (address.length > LIMITS.addressMax) fields.address = `Addresses are limited to ${LIMITS.addressMax} characters.`;
    else patch.address = address || null;
  }
  if (body.category !== undefined) {
    const category = cleanText(body.category);
    if (category.length > LIMITS.categoryMax) fields.category = `Categories are limited to ${LIMITS.categoryMax} characters.`;
    else patch.category = category || null;
  }
  if (body.description !== undefined) {
    const description = cleanMultiline(body.description);
    if (description.length > LIMITS.descriptionMax) {
      fields.description = `Descriptions are limited to ${LIMITS.descriptionMax} characters.`;
    } else patch.description = description || null;
  }
  if (body.phone !== undefined) {
    const phone = cleanText(body.phone);
    if (phone.length > LIMITS.phoneMax) fields.phone = `Phone numbers are limited to ${LIMITS.phoneMax} characters.`;
    else patch.phone = phone || null;
  }
  if (body.website !== undefined) {
    const website = cleanText(body.website);
    if (website && !isHttpUrl(website)) fields.website = 'The website needs an http(s) link.';
    else patch.website = website || null;
  }
  if (body.hours !== undefined) {
    const hours = cleanMultiline(body.hours);
    if (hours.length > LIMITS.hoursMax) fields.hours = `Opening hours are limited to ${LIMITS.hoursMax} characters.`;
    else patch.hours = hours || null;
  }

  if (Object.keys(fields).length) {
    throw new BusinessError('invalid_patch', 'Some details need fixing.', { fields });
  }
  if (!Object.keys(patch).length) {
    throw new BusinessError('invalid_patch', 'Change at least one detail.', { fields: { profile: 'Change at least one detail.' } });
  }
  return patch;
}

// Queue query: which claims, and paging.
function parseQueueQuery(q = {}) {
  const view = ['pending', 'superseded', 'all'].includes(q.view) ? q.view : 'pending';
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = LIMITS.pageDefault;
  limit = Math.min(limit, LIMITS.pageMax);
  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { view, limit, offset };
}

// Comma-separated usernames from configuration, compared case-insensitively.
// Same convention as community and reports reviewers.
function parseReviewers(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// The days a pending claim has left before the 30-day expiry, for the queue
// and the dashboard. Never negative.
function daysLeft(claim, now = new Date()) {
  if (!claim || !claim.expiresAt || claim.status !== 'pending') return null;
  const ms = new Date(claim.expiresAt).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 3600 * 1000)));
}

module.exports = {
  BusinessError,
  CLAIM_STATUSES,
  CLAIM_STATUS_IDS,
  PROFILE_STATUSES,
  PROFILE_STATUS_IDS,
  TRANSITIONS,
  REJECT_REASONS,
  REJECT_REASON_IDS,
  LIMITS,
  APP_FILE_PATH,
  IMAGE_TYPES,
  EDITABLE_FIELDS,
  claimStatusLabel,
  profileStatusLabel,
  isClaimStatus,
  isOwner,
  isClaimant,
  canClaim,
  claimBlockReason,
  canEditProfile,
  editBlockReason,
  canDecide,
  decideBlockReason,
  canModerate,
  canViewAudit,
  canFlag,
  flagBlockReason,
  assertDecision,
  validateClaim,
  validateDecision,
  validateProfilePatch,
  parseQueueQuery,
  parseReviewers,
  daysLeft,
};
