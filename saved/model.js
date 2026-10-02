// Saved places model — the pure, I/O-free rules for Phase 7.
//
// Everything that decides WHAT is allowed lives here: the default lists, the
// list-name limits, the shape of a place reference, and the validation of
// every input the routes accept. saved/store.js enforces these against
// Postgres; tests/saved.model.test.js drives them without a database. Keeping
// the rules in one synchronous module means the server and the tests can never
// disagree about them.
//
// A saved place references a REAL place: `place_id` (the stable id the search
// stack already gives every result, search/normalize.js) plus whatever display
// values actually came with it. Nothing here invents a place, and no second
// place model is introduced — the display fields are a cache of the real
// normalized search/place result so a saved list can render without asking a
// provider again.
'use strict';

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

// The four default lists every person starts with. `slug` is the stable
// identifier the API and the database use; `name` is the default display name
// the owner may rename (the slug never changes, so integrations keep working
// after a rename). `kind` is 'default' or 'custom'; `system_key` ties a
// default list to this enum and is NULL for custom lists — which is exactly
// what lets duplicate prevention differ between the two.
const DEFAULT_LISTS = [
  { slug: 'favorites', name: 'Favorites' },
  { slug: 'want_to_visit', name: 'Want to Visit' },
  { slug: 'travel', name: 'Travel' },
  { slug: 'restaurants', name: 'Restaurants' },
];

const DEFAULT_LIST_SLUGS = DEFAULT_LISTS.map((l) => l.slug);

const LIMITS = {
  listNameMin: 1,
  listNameMax: 60,
  maxCustomLists: 50,
  placeIdMax: 300,
  placeNameMax: 200,
  placeAddressMax: 400,
  placeCategoryMax: 60,
  placeSubcategoryMax: 60,
  placeSourceMax: 60,
};

// The slug a seeded default list is recognised by. Only ever compared against
// the four above; it is never re-derived from user input.
function isDefaultSlug(slug) {
  return DEFAULT_LIST_SLUGS.includes(slug);
}

function savedError(code, message, opts) {
  return new SavedError(code, message, opts);
}

function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

// A trimmed string capped at `max`, or null when nothing real is present.
function optionalText(raw, max) {
  const value = cleanText(raw);
  if (!value) return null;
  return value.slice(0, max);
}

// List names: whitespace collapsed, length checked, per-field error message.
function validateListName(raw, fields, { field = 'name' } = {}) {
  const name = cleanText(raw);
  if (name.length < LIMITS.listNameMin) {
    fields[field] = 'Give the list a name.';
    return '';
  }
  if (name.length > LIMITS.listNameMax) {
    fields[field] = `List names are limited to ${LIMITS.listNameMax} characters.`;
    return '';
  }
  return name;
}

// A place reference. `id` is required (it is the link to the real place) and
// the display fields are optional, stored as given: never fabricated.
function validatePlace(raw, fields, { field = 'place' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fields[field] = 'A place is required.';
    return null;
  }
  const id = cleanText(raw.id);
  if (!id) {
    fields[field] = 'The place needs an id.';
    return null;
  }
  if (id.length > LIMITS.placeIdMax) {
    fields[field] = 'That place id is too long.';
    return null;
  }
  const lat = raw.lat == null ? null : Number(raw.lat);
  const lng = raw.lng == null ? null : Number(raw.lng);
  const hasLat = Number.isFinite(lat);
  const hasLng = Number.isFinite(lng);
  if (hasLat !== hasLng) {
    fields[field] = 'The place coordinates are incomplete.';
    return null;
  }
  if (hasLat && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) {
    fields[field] = 'The place coordinates are out of range.';
    return null;
  }
  return {
    id,
    name: optionalText(raw.name, LIMITS.placeNameMax),
    address: optionalText(raw.address, LIMITS.placeAddressMax),
    category: optionalText(raw.category, LIMITS.placeCategoryMax),
    subcategory: optionalText(raw.subcategory, LIMITS.placeSubcategoryMax),
    lat: hasLat ? lat : null,
    lng: hasLng ? lng : null,
    source: optionalText(raw.source, LIMITS.placeSourceMax),
  };
}

// A place id on its own (unsave, membership, "is saved?"). Ids are opaque
// strings, so this only rejects empty or absurdly long values; anything else
// simply will not match a stored row.
function validatePlaceId(raw) {
  const id = cleanText(raw);
  if (!id) throw savedError('invalid_request', 'A place id is required.');
  if (id.length > LIMITS.placeIdMax) {
    throw savedError('invalid_request', 'That place id is too long.');
  }
  return id;
}

// A list id from the path or body. Positive integers only, so a malformed id
// is a 400 rather than a query that scans for something it cannot find.
function validateListId(raw) {
  const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!/^\d{1,18}$/.test(text)) {
    throw savedError('invalid_request', 'That list id is not valid.');
  }
  const id = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw savedError('invalid_request', 'That list id is not valid.');
  }
  return id;
}

function validateCreateList(input) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  const name = validateListName(body.name, fields);
  const description = optionalText(body.description, 200);
  if (Object.keys(fields).length) {
    throw savedError('invalid_list', 'Some details need fixing.', { fields });
  }
  return { name, description };
}

function validateUpdateList(input) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  if (!Object.prototype.hasOwnProperty.call(body, 'name')) {
    throw savedError('invalid_list', 'A name is required.', { fields: { name: 'Give the list a name.' } });
  }
  const name = validateListName(body.name, fields);
  if (Object.keys(fields).length) {
    throw savedError('invalid_list', 'Some details need fixing.', { fields });
  }
  return { name };
}

function validateSave(input) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};
  const place = validatePlace(body.place, fields);
  const listSlug = body.list == null || body.list === '' ? null : cleanText(body.list);
  if (listSlug && listSlug.length > LIMITS.listNameMax) {
    fields.list = 'That list is not valid.';
  }
  if (Object.keys(fields).length) {
    throw savedError('invalid_save', 'Some details need fixing.', { fields });
  }
  return { place, listSlug };
}

module.exports = {
  SavedError,
  savedError,
  DEFAULT_LISTS,
  DEFAULT_LIST_SLUGS,
  LIMITS,
  isDefaultSlug,
  validateListName,
  validatePlace,
  validatePlaceId,
  validateListId,
  validateCreateList,
  validateUpdateList,
  validateSave,
};
