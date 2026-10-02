// Reports model — pure, I/O-free rules.
//
// The Phase 6 counterpart of community/model.js, mirroring its shape so the
// reports store and routes read like the proposal ones: same CommunityError
// contract, same error envelope, same validation discipline. Everything that
// decides what a report may contain, who may act on it, which status moves
// are legal, and when a report expires lives here, with no I/O.
'use strict';

const { CommunityError } = require('../community/model');

// Same text discipline as community/model.js: single-line fields collapse
// whitespace runs, multiline fields keep line structure but trim the edges.
function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function cleanMultiline(raw) {
  return typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

// The eleven report types from the spec, in the order they were named. Each
// carries its own default expiration window in hours, so the model owns the
// whole policy: adding a type here is the entire change.
const TYPES = [
  { id: 'traffic', label: 'Traffic', expiresHours: 3 },
  { id: 'accident', label: 'Accident', expiresHours: 6 },
  { id: 'road_closed', label: 'Road closed', expiresHours: 24 * 7 },
  { id: 'construction', label: 'Construction', expiresHours: 24 * 30 },
  { id: 'hazard', label: 'Hazard', expiresHours: 12 },
  { id: 'flood', label: 'Flood', expiresHours: 24 },
  { id: 'fire', label: 'Fire', expiresHours: 12 },
  { id: 'broken_road', label: 'Broken road', expiresHours: 24 * 30 },
  { id: 'wrong_map_data', label: 'Wrong map data', expiresHours: 24 * 90 },
  { id: 'place_closed', label: 'Place closed', expiresHours: 24 * 90 },
  { id: 'other', label: 'Other', expiresHours: 24 * 14 },
];
const TYPE_BY_ID = new Map(TYPES.map((t) => [t.id, t]));

// Stored statuses. `expired` is deliberately absent: expiration is DERIVED on
// every read (see effectiveStatus), never written, so a past expires_at can
// never be contradicted by a stale column.
const STATUSES = [
  { id: 'pending', label: 'Pending' },
  { id: 'verified', label: 'Verified' },
  { id: 'rejected', label: 'Rejected' },
];
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

// Derived, never stored.
const EXPIRED = 'expired';

// The reviewer-only lifecycle: pending -> verified or rejected, and a
// verified report can still be rejected. A rejected report is terminal. No
// author move exists — reporting is not editing.
const TRANSITIONS = {
  pending: { verified: 'reviewer', rejected: 'reviewer' },
  verified: { rejected: 'reviewer' },
  rejected: {},
};

// The reports feed's views. "recent" and "nearby" both mean "what is
// happening now" (so both exclude derived-expired rows); "mine" is the
// reporter's own history, expired rows included. A separate includeExpired
// query flag can still ask any view for the full history.
const FEED_VIEWS = ['recent', 'nearby', 'mine'];

const LIMITS = {
  descriptionMax: 2000,
  reasonMax: 500,
  placeRefMax: 200,
  pageMax: 50,
  pageDefault: 20,
  nearbyRadiusKmDefault: 25,
  nearbyRadiusKmMax: 200,
};

const REACTION_VALUES = ['confirm', 'disagree'];

function typeLabel(id) {
  const t = TYPE_BY_ID.get(id);
  return t ? t.label : id;
}

function isType(id) {
  return TYPE_BY_ID.has(id);
}

function statusLabel(id) {
  const s = STATUSES.find((x) => x.id === id);
  return s ? s.label : id;
}

// The expiration instant for a type, as an ISO string, from `from` (or now).
function expiresAtFor(typeId, from = new Date()) {
  const type = TYPE_BY_ID.get(typeId);
  if (!type) throw new Error(`unknown report type: ${typeId}`);
  return new Date(from.getTime() + type.expiresHours * 3600 * 1000).toISOString();
}

// Whether a report is expired at `now`: past its expires_at AND not rejected
// (a reviewer's rejection is a standing answer, so it never reads as
// expiration). Deliberately the same formula the store uses in SQL when
// filtering current views — this is the derivation, that one mirrors it.
function effectiveStatus(report, now = new Date()) {
  if (!report) return null;
  const expiresAt = report.expiresAt instanceof Date ? report.expiresAt : new Date(report.expiresAt);
  if (report.status !== 'rejected' && now.getTime() > expiresAt.getTime()) return EXPIRED;
  return report.status;
}

// ── roles and permissions ────────────────────────────────────────────────

// `viewer` is { id, username, reviewer } — the same shape community/routes.js
// builds. `report` needs { reporterId, status, expiresAt }.
function isReporter(viewer, report) {
  return Boolean(viewer && report && String(viewer.id) === String(report.reporterId));
}

// Confirm/Disagree: anyone except the original reporter.
function canReact(viewer, report) {
  return Boolean(viewer && report && !isReporter(viewer, report));
}

// Report abuse: the same reporter restriction.
function canFlag(viewer, report) {
  return Boolean(viewer && report && !isReporter(viewer, report));
}

function reactBlockReason(viewer, report) {
  return canReact(viewer, report) ? null : 'You cannot react to your own report.';
}

function flagBlockReason(viewer, report) {
  return canFlag(viewer, report) ? null : 'You cannot flag your own report.';
}

// The transitions `viewer` may apply right now, in enum order. Every move in
// this lifecycle is reviewer-only, so only a reviewer sees any.
function allowedTransitions(viewer, report) {
  const moves = TRANSITIONS[report.status] || {};
  return Object.entries(moves)
    .filter(([, who]) => who === 'reviewer' && Boolean(viewer && viewer.reviewer))
    .map(([to]) => to);
}

// Throws unless `viewer` may move `report` to `to`. Same contract as
// community/model.js assertTransition: unknown target is invalid_status, a
// move the lifecycle does not list is invalid_transition (409), and the wrong
// role is forbidden (403).
function assertTransition(viewer, report, to) {
  if (!STATUS_IDS.has(to)) {
    throw new CommunityError('invalid_status', 'That status does not exist.');
  }
  const moves = TRANSITIONS[report.status] || {};
  const who = moves[to];
  if (!who) {
    throw new CommunityError(
      'invalid_transition',
      `A report that is ${statusLabel(report.status)} cannot become ${statusLabel(to)}.`,
      { status: 409 },
    );
  }
  if (who === 'reviewer' && !(viewer && viewer.reviewer)) {
    throw new CommunityError('forbidden', 'Only community reviewers can change a report status.', {
      status: 403,
    });
  }
}

// ── validation ───────────────────────────────────────────────────────────

// A soft place reference: both halves present or both absent, each bounded
// text. Shape validation only — there is no place table to resolve it
// against, per the spec.
function validatePlaceRef(placeId, placeProvider, fields) {
  const id = cleanText(placeId);
  const provider = cleanText(placeProvider);
  if (!id && !provider) return null;
  if (!id || !provider) {
    fields.placeId = 'A place reference needs an id and a provider.';
    return null;
  }
  if (id.length > LIMITS.placeRefMax || provider.length > LIMITS.placeRefMax) {
    fields.placeId = `Place references are limited to ${LIMITS.placeRefMax} characters.`;
    return null;
  }
  return { placeId: id, placeProvider: provider };
}

// Validate and clean the create payload. Same contract as validateDraft:
// throws a CommunityError carrying per-field messages the form shows next to
// each input, or returns the clean values. The spec pins the codes: a bad
// type is invalid_report_type and bad coordinates are invalid_coordinates.
function validateReport(input) {
  const src = input && typeof input === 'object' ? input : {};

  const type = cleanText(src.type).toLowerCase();
  if (!TYPE_BY_ID.has(type)) {
    throw new CommunityError('invalid_report_type', 'Choose a report type.', {
      fields: { type: 'Choose a report type.' },
    });
  }

  const lat = Number(src.lat);
  const lng = Number(src.lng);
  const coordsOk =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!coordsOk) {
    throw new CommunityError('invalid_coordinates', 'A report needs valid coordinates.', {
      fields: { location: 'The coordinates are out of range.' },
    });
  }

  const fields = {};
  const description = cleanMultiline(src.description);
  if (description.length > LIMITS.descriptionMax) {
    fields.description = `Descriptions are limited to ${LIMITS.descriptionMax} characters.`;
  }
  const place = validatePlaceRef(src.placeId, src.placeProvider, fields);
  if (Object.keys(fields).length) {
    throw new CommunityError('invalid_report', 'Some details need fixing.', { fields });
  }

  return {
    type,
    lat,
    lng,
    description: description || null,
    placeId: place ? place.placeId : null,
    placeProvider: place ? place.placeProvider : null,
  };
}

// Feed query parsing: view, paging, the nearby centre, and the
// report-specific filters (type, placeId, includeExpired).
function parseFeedQuery(q = {}) {
  const view = FEED_VIEWS.includes(q.view) ? q.view : 'recent';
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = LIMITS.pageDefault;
  limit = Math.min(limit, LIMITS.pageMax);
  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  let type = null;
  if (q.type != null && cleanText(q.type) !== '') {
    const candidate = cleanText(q.type).toLowerCase();
    if (!TYPE_BY_ID.has(candidate)) {
      throw new CommunityError('invalid_report_type', 'Choose a report type.', {
        fields: { type: 'Choose a report type.' },
      });
    }
    type = candidate;
  }
  let placeId = null;
  if (q.placeId != null && cleanText(q.placeId) !== '') {
    const candidate = cleanText(q.placeId);
    if (candidate.length > LIMITS.placeRefMax) {
      throw new CommunityError('invalid_query', 'That place reference is too long.');
    }
    placeId = candidate;
  }
  const includeExpired = q.includeExpired === '1' || q.includeExpired === 'true';
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
  return { view, limit, offset, near, radiusKm, type, placeId, includeExpired };
}

// 'confirm' | 'disagree', else invalid_reaction (the reports analogue of
// invalid_vote).
function parseReactionValue(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!REACTION_VALUES.includes(v)) {
    throw new CommunityError('invalid_reaction', 'A reaction is either confirm or disagree.');
  }
  return v;
}

// Flag reason: optional, bounded single line.
function parseFlagReason(raw) {
  const reason = cleanText(raw);
  if (reason.length > LIMITS.reasonMax) {
    throw new CommunityError('invalid_report', 'Some details need fixing.', {
      fields: { reason: `Reasons are limited to ${LIMITS.reasonMax} characters.` },
    });
  }
  return reason || null;
}

module.exports = {
  CommunityError,
  TYPES,
  STATUSES,
  TRANSITIONS,
  FEED_VIEWS,
  LIMITS,
  REACTION_VALUES,
  EXPIRED,
  cleanText,
  cleanMultiline,
  typeLabel,
  isType,
  statusLabel,
  expiresAtFor,
  effectiveStatus,
  isReporter,
  canReact,
  canFlag,
  reactBlockReason,
  flagBlockReason,
  allowedTransitions,
  assertTransition,
  validateReport,
  validatePlaceRef,
  parseFeedQuery,
  parseReactionValue,
  parseFlagReason,
};