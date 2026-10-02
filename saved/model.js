// Saved places model — pure, I/O-free rules.
//
// The server-side twin of community/model.js: everything that decides WHAT
// is allowed lives here — who may see or write a list, what a valid list,
// place snapshot, note, suggestion and comment look like — and store.js
// enforces the rules against Postgres inside transactions. tests/
// saved.model.test.js drives this module without a database, so the server
// and the tests can never disagree about the rules.
'use strict';

const crypto = require('crypto');

// A typed error the routes turn into the app's standard JSON error shape.
class SavedError extends Error {
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message);
    this.name = 'SavedError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

// Visibility levels. `link` is the Shared level: anyone in Homeroom holding
// the list's unguessable share token can view it (never write). Per-person
// sharing is a later extension; the CHECK constraint and share_token column
// leave room for it without migrating existing rows.
const VISIBILITIES = ['private', 'link', 'public'];

const LIMITS = {
  nameMin: 1,
  nameMax: 60,
  noteMax: 500,
  messageMax: 200,
  commentMin: 1,
  commentMax: 1000,
  placeNameMax: 200,
  placeAddressMax: 300,
  placeKindMax: 50,
  placeProviderMax: 50,
  placeIdMax: 200,
  pageMax: 50,
  pageDefault: 20,
};

// The curated palette the form offers. Validation is membership in this set,
// so an emoji is always one the UI itself can render.
const EMOJIS = [
  '⭐', '🧭', '✈️', '🍴', '☕', '🥐', '🌅', '🌊',
  '🏛️', '🌳', '⛰️', '🏖️', '🎡', '🛍️', '🎨', '🎭',
  '🍺', '🍜', '🚲', '⛺', '📸', '💗', '🗺️', '🏪',
];
const EMOJI_SET = new Set(EMOJIS);

// The four roadmap-P7 defaults, created lazily the first time a person opens
// their lists (production behaviour for every user, never staging seeding).
const DEFAULT_LISTS = [
  { name: 'Favorites', emoji: '⭐' },
  { name: 'Want to Visit', emoji: '🧭' },
  { name: 'Travel', emoji: '✈️' },
  { name: 'Restaurants', emoji: '🍴' },
];

// A search result's id is a provider id, or a "lat,lon" fallback when the
// provider gave none (see places-model.js placeFromSearchResult). Only the
// former identifies a place across providers; the fallback is just geometry.
const COORDINATE_ID = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

// ── roles and permissions ────────────────────────────────────────────────

// `viewer` is { id, username }. `list` needs { ownerId, visibility,
// shareToken } — the shape toProposal-style readers build from the row.
function isOwner(viewer, list) {
  return Boolean(viewer && list && String(viewer.id) === String(list.ownerId));
}

// Every mutation on a list — its details, its items, its suggestions — is
// the owner's alone, regardless of visibility.
function canWrite(viewer, list) {
  return isOwner(viewer, list);
}

// The one visibility predicate every store read and write goes through. A
// viewer who cannot see a list is answered "not found" by the store, never
// "forbidden", so a private list's existence never leaks (the same
// convention community/store.js readRow uses for drafts).
function canView(viewer, list, { key = null } = {}) {
  if (!viewer || !list) return false;
  if (isOwner(viewer, list)) return true;
  if (list.visibility === 'public') return true;
  if (list.visibility === 'link') {
    return Boolean(key) && Boolean(list.shareToken) && String(key) === String(list.shareToken);
  }
  return false;
}

// ── validation ───────────────────────────────────────────────────────────

function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function cleanMultiline(raw) {
  return typeof raw === 'string'
    ? raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';
}

// Create: every field required (with defaults). Patch: only provided fields
// change; the store merges and revalidates the whole, like proposals do.
function validateListInput(raw, { partial = false } = {}) {
  const fields = {};
  const body = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    const name = cleanText(body.name);
    if (name.length < LIMITS.nameMin) fields.name = 'Give the list a name.';
    else if (name.length > LIMITS.nameMax) {
      fields.name = `List names are limited to ${LIMITS.nameMax} characters.`;
    } else out.name = name;
  }

  if (!partial || has('emoji')) {
    const emoji = typeof body.emoji === 'string' ? body.emoji : '';
    if (!emoji) out.emoji = EMOJIS[0];
    else if (!EMOJI_SET.has(emoji)) fields.emoji = 'Choose an emoji from the palette.';
    else out.emoji = emoji;
  }

  if (!partial || has('visibility')) {
    const visibility = typeof body.visibility === 'string' ? body.visibility : '';
    if (!visibility) out.visibility = 'private';
    else if (!VISIBILITIES.includes(visibility)) fields.visibility = 'Choose Private, Shared or Public.';
    else out.visibility = visibility;
  }

  if (Object.keys(fields).length) {
    throw new SavedError('invalid_list', 'Some details need fixing.', { fields });
  }
  return out;
}

// The saved place is a SNAPSHOT of a search result at save time: items are
// never re-fetched or enriched, so nothing on them can silently change or
// be fabricated (no place provider is connected; see places-model.js).
function validatePlace(raw) {
  const fields = {};
  const body = raw && typeof raw === 'object' ? raw : {};
  const name = cleanText(body.name);
  if (!name) fields.place = 'A place needs a name.';
  else if (name.length > LIMITS.placeNameMax) {
    fields.place = `Place names are limited to ${LIMITS.placeNameMax} characters.`;
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (
    !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    !Number.isFinite(lng) || lng < -180 || lng > 180
  ) {
    fields.place = fields.place || 'The place coordinates are out of range.';
  }

  if (Object.keys(fields).length) {
    throw new SavedError('invalid_place', 'This place could not be saved.', { fields });
  }

  const clip = (value, max) => {
    const s = cleanText(value);
    return s ? (s.length > max ? s.slice(0, max) : s) : null;
  };
  const id = cleanText(body.id);
  return {
    name,
    lat,
    lng,
    address: clip(body.address, LIMITS.placeAddressMax),
    kind: clip(body.kind, LIMITS.placeKindMax),
    provider: clip(body.provider, LIMITS.placeProviderMax),
    id: id ? id.slice(0, LIMITS.placeIdMax) : null,
  };
}

// The stable identity of a saved place within one list: a real provider id
// when the search result carried one, else its rounded coordinates. The
// UNIQUE (list_id, place_key) constraint makes "no duplicates in a list" a
// database fact.
function placeKeyOf(place) {
  if (place.id && !COORDINATE_ID.test(place.id)) {
    return `${place.provider || 'search'}:${place.id}`;
  }
  return `coord:${place.lat.toFixed(5)},${place.lng.toFixed(5)}`;
}

// The owner's one paragraph about an item. Empty becomes null (no note).
function validateNote(raw) {
  const note = cleanMultiline(raw);
  if (note.length > LIMITS.noteMax) {
    throw new SavedError('invalid_place', 'The note is too long.', {
      fields: { note: `Notes are limited to ${LIMITS.noteMax} characters.` },
    });
  }
  return note || null;
}

function validateMessage(raw) {
  const message = cleanMultiline(raw);
  if (message.length > LIMITS.messageMax) {
    throw new SavedError('invalid_place', 'The message is too long.', {
      fields: { message: `Messages are limited to ${LIMITS.messageMax} characters.` },
    });
  }
  return message || null;
}

function validateCommentBody(raw) {
  const body = cleanMultiline(raw);
  if (!body) {
    throw new SavedError('invalid_comment', 'Write a comment first.');
  }
  if (body.length > LIMITS.commentMax) {
    throw new SavedError('comment_too_long', 'Comments are limited to 1000 characters.');
  }
  return body;
}

// Feed-style paging for the public directory (the mine view is bounded by
// one person's lists, but it pages the same way).
function parsePageQuery(q = {}) {
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = LIMITS.pageDefault;
  limit = Math.min(limit, LIMITS.pageMax);
  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

// Unguessable link token for the Shared level: 32 hex characters, like the
// platform's own /app-files/ ids.
function generateShareToken() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  SavedError,
  VISIBILITIES,
  LIMITS,
  EMOJIS,
  DEFAULT_LISTS,
  isOwner,
  canWrite,
  canView,
  validateListInput,
  validatePlace,
  placeKeyOf,
  validateNote,
  validateMessage,
  validateCommentBody,
  parsePageQuery,
  generateShareToken,
};
