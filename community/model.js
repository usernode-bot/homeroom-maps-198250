// Community proposal model — pure, I/O-free rules.
//
// Everything that decides WHAT is allowed lives here: the categories, the
// status lifecycle and its transitions, who may edit or vote in which status,
// and input validation. store.js enforces these rules against Postgres;
// tests/community.model.test.js drives them without a database. Keeping the
// rules in one synchronous module means the server and the tests can never
// disagree about them.
'use strict';

// A typed error the routes turn into the app's standard JSON error shape.
class CommunityError extends Error {
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message);
    this.name = 'CommunityError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

// Proposal categories. `needsLocation` is true for every category that is
// about a specific spot; a map-wide improvement is the one that may omit it.
const CATEGORIES = [
  { id: 'add_missing_place', label: 'Add missing place', needsLocation: true },
  { id: 'correct_place', label: 'Correct place', needsLocation: true },
  { id: 'update_hours', label: 'Update hours', needsLocation: true },
  { id: 'correct_location', label: 'Correct location', needsLocation: true },
  { id: 'report_wrong_information', label: 'Report wrong information', needsLocation: true },
  { id: 'add_landmark', label: 'Add landmark', needsLocation: true },
  { id: 'suggest_map_improvement', label: 'Suggest map improvement', needsLocation: false },
];
const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

const STATUSES = [
  { id: 'draft', label: 'Draft' },
  { id: 'open', label: 'Open' },
  { id: 'under_review', label: 'Under Review' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'implemented', label: 'Implemented' },
];
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

// The lifecycle. Each allowed move names who may make it: the proposal's
// `author`, or a `reviewer` (see roles below). Anything not listed is refused;
// Rejected and Implemented are terminal.
const TRANSITIONS = {
  draft: { open: 'author' },
  open: { under_review: 'reviewer', rejected: 'reviewer' },
  under_review: { accepted: 'reviewer', rejected: 'reviewer', open: 'reviewer' },
  accepted: { implemented: 'reviewer' },
  rejected: {},
  implemented: {},
};

// Statuses other people can see. A draft is visible to its author only.
const PUBLIC_STATUSES = ['open', 'under_review', 'accepted', 'rejected', 'implemented'];
// Statuses that take votes: the community weighs in while a proposal is
// still undecided. Once decided, the tally is frozen as it stood.
const VOTABLE_STATUSES = new Set(['open', 'under_review']);

const FEED_VIEWS = ['recent', 'popular', 'nearby', 'implemented', 'mine'];

const LIMITS = {
  titleMin: 4,
  titleMax: 120,
  descriptionMin: 10,
  descriptionMax: 4000,
  locationNameMax: 200,
  attachmentsMax: 4,
  pageMax: 50,
  pageDefault: 20,
  nearbyRadiusKmDefault: 25,
  nearbyRadiusKmMax: 200,
};

// Platform-stored files have an unguessable 32-hex id under /app-files/.
// Only those URLs are accepted as attachments, so a proposal can never carry
// an arbitrary third-party link dressed up as a photo.
const APP_FILE_PATH = /^\/app-files\/[0-9a-f]{32}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function statusLabel(id) {
  const s = STATUSES.find((x) => x.id === id);
  return s ? s.label : id;
}

function categoryLabel(id) {
  const c = CATEGORY_BY_ID.get(id);
  return c ? c.label : id;
}

function isStatus(id) {
  return STATUS_IDS.has(id);
}

// ── roles and permissions ────────────────────────────────────────────────

// `viewer` is { id, username, reviewer } (reviewer: boolean, resolved by the
// caller from configuration). `proposal` needs { authorId, status, votes }.
function isAuthor(viewer, proposal) {
  return Boolean(viewer && proposal && String(viewer.id) === String(proposal.authorId));
}

function canView(viewer, proposal) {
  if (!proposal || proposal.hidden) return false;
  if (proposal.status === 'draft') return isAuthor(viewer, proposal);
  return true;
}

// The author edits a draft freely. Once published, edits are allowed only
// until the first vote lands, so nobody can change what people voted on.
// From Under Review onwards the text is locked.
function canEdit(viewer, proposal) {
  if (!isAuthor(viewer, proposal)) return false;
  if (proposal.status === 'draft') return true;
  if (proposal.status === 'open') {
    const v = proposal.votes || {};
    return (v.up || 0) + (v.down || 0) === 0;
  }
  return false;
}

function editBlockReason(viewer, proposal) {
  if (!isAuthor(viewer, proposal)) return 'Only the author can edit this proposal.';
  if (proposal.status === 'open') return 'This proposal has votes, so it can no longer be edited.';
  return `A proposal that is ${statusLabel(proposal.status)} can no longer be edited.`;
}

// Voting is for other people: an author cannot vote on their own proposal.
function canVote(viewer, proposal) {
  if (!viewer || !proposal) return false;
  if (isAuthor(viewer, proposal)) return false;
  return VOTABLE_STATUSES.has(proposal.status);
}

function voteBlockReason(viewer, proposal) {
  if (isAuthor(viewer, proposal)) return 'You cannot vote on your own proposal.';
  return `Voting is closed for proposals that are ${statusLabel(proposal.status)}.`;
}

function allowedTransitions(viewer, proposal) {
  const moves = TRANSITIONS[proposal.status] || {};
  return Object.entries(moves)
    .filter(([, who]) => (who === 'author' ? isAuthor(viewer, proposal) : Boolean(viewer && viewer.reviewer)))
    .map(([to]) => to);
}

// Throws unless `viewer` may move `proposal` to `to`.
function assertTransition(viewer, proposal, to) {
  if (!isStatus(to)) {
    throw new CommunityError('invalid_status', 'That status does not exist.');
  }
  const moves = TRANSITIONS[proposal.status] || {};
  const who = moves[to];
  if (!who) {
    throw new CommunityError(
      'invalid_transition',
      `A proposal that is ${statusLabel(proposal.status)} cannot become ${statusLabel(to)}.`,
      { status: 409 },
    );
  }
  if (who === 'author' && !isAuthor(viewer, proposal)) {
    throw new CommunityError('forbidden', 'Only the author can do that.', { status: 403 });
  }
  if (who === 'reviewer' && !(viewer && viewer.reviewer)) {
    throw new CommunityError('forbidden', 'Only community reviewers can change this status.', {
      status: 403,
    });
  }
}

// ── validation ───────────────────────────────────────────────────────────

function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function cleanMultiline(raw) {
  return typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

function validateLocation(raw, fields) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    fields.location = 'The location is malformed.';
    return null;
  }
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const name = cleanText(raw.name);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    fields.location = 'The location coordinates are out of range.';
    return null;
  }
  if (!name) {
    fields.location = 'Give the location a name.';
    return null;
  }
  if (name.length > LIMITS.locationNameMax) {
    fields.location = `Location names are limited to ${LIMITS.locationNameMax} characters.`;
    return null;
  }
  return { name, lat, lng };
}

// `platformOrigin` (optional) pins attachment URLs to the platform's host.
function validateAttachments(raw, fields, { platformOrigin = '' } = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    fields.attachments = 'Attachments must be a list.';
    return [];
  }
  if (raw.length > LIMITS.attachmentsMax) {
    fields.attachments = `Attach at most ${LIMITS.attachmentsMax} photos.`;
    return [];
  }
  const out = [];
  for (const item of raw) {
    let url;
    try {
      url = new URL(String(item && item.url));
    } catch {
      fields.attachments = 'One of the attachments is not a stored photo.';
      return [];
    }
    const originOk = platformOrigin ? url.origin === platformOrigin : /^https?:$/.test(url.protocol);
    if (!originOk || !APP_FILE_PATH.test(url.pathname) || url.search || url.hash) {
      fields.attachments = 'One of the attachments is not a stored photo.';
      return [];
    }
    const contentType = String((item && item.contentType) || '');
    if (contentType && !IMAGE_TYPES.has(contentType)) {
      fields.attachments = 'Attachments must be images.';
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
    fields.attachments = 'The same photo is attached twice.';
    return [];
  }
  return out;
}

// Validate a full proposal body (create, or the merged result of an edit).
// Returns the cleaned values or throws a CommunityError carrying per-field
// messages the form shows next to each input.
function validateDraft(input, opts = {}) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  const title = cleanText(body.title);
  const description = cleanMultiline(body.description);
  const category = typeof body.category === 'string' ? body.category : '';

  if (title.length < LIMITS.titleMin) fields.title = `Use at least ${LIMITS.titleMin} characters.`;
  else if (title.length > LIMITS.titleMax) fields.title = `Titles are limited to ${LIMITS.titleMax} characters.`;

  if (description.length < LIMITS.descriptionMin) {
    fields.description = `Use at least ${LIMITS.descriptionMin} characters.`;
  } else if (description.length > LIMITS.descriptionMax) {
    fields.description = `Descriptions are limited to ${LIMITS.descriptionMax} characters.`;
  }

  const cat = CATEGORY_BY_ID.get(category);
  if (!cat) fields.category = 'Choose a category.';

  const location = validateLocation(body.location, fields);
  if (cat && cat.needsLocation && !location && !fields.location) {
    fields.location = 'This kind of proposal needs a location.';
  }

  const attachments = validateAttachments(body.attachments, fields, opts);

  if (Object.keys(fields).length) {
    throw new CommunityError('invalid_proposal', 'Some details need fixing.', { fields });
  }
  return { title, description, category, location, attachments };
}

function parseVoteValue(raw) {
  const v = Number(raw);
  if (v !== 1 && v !== -1) {
    throw new CommunityError('invalid_vote', 'A vote is either up (1) or down (-1).');
  }
  return v;
}

// Feed query parsing: view, paging and the nearby centre.
function parseFeedQuery(q = {}) {
  const view = FEED_VIEWS.includes(q.view) ? q.view : 'recent';
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = LIMITS.pageDefault;
  limit = Math.min(limit, LIMITS.pageMax);
  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  let near = null;
  let radiusKm = LIMITS.nearbyRadiusKmDefault;
  if (view === 'nearby') {
    const parts = String(q.near || '').split(',').map(Number);
    if (
      parts.length !== 2 ||
      !parts.every(Number.isFinite) ||
      Math.abs(parts[0]) > 90 ||
      Math.abs(parts[1]) > 180
    ) {
      throw new CommunityError('invalid_query', 'Nearby needs your location as near=lat,lng.');
    }
    near = { lat: parts[0], lng: parts[1] };
    const r = Number(q.radius);
    if (Number.isFinite(r) && r > 0) radiusKm = Math.min(r, LIMITS.nearbyRadiusKmMax);
  }
  return { view, limit, offset, near, radiusKm };
}

// Comma-separated usernames from configuration, compared case-insensitively.
function parseReviewers(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

module.exports = {
  CommunityError,
  CATEGORIES,
  STATUSES,
  TRANSITIONS,
  PUBLIC_STATUSES,
  VOTABLE_STATUSES,
  FEED_VIEWS,
  LIMITS,
  statusLabel,
  categoryLabel,
  isStatus,
  isAuthor,
  canView,
  canEdit,
  editBlockReason,
  canVote,
  voteBlockReason,
  allowedTransitions,
  assertTransition,
  validateDraft,
  parseVoteValue,
  parseFeedQuery,
  parseReviewers,
};
