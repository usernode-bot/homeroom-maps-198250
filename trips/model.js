// Trip model — pure, I/O-free rules for the Trip & Day planner (Phase 10).
//
// Everything that decides WHAT is allowed lives here: the date range and its
// day expansion, destination and per-item validation, and the array math the
// store and the screen both rely on. The store enforces these rules against
// Postgres; tests/trips.model.test.js drives them without a database, so the
// server and the client can never disagree about them.
'use strict';

// A typed error the route handler turns into the app's standard JSON error
// shape (error.code / error.message / error.fields).
class TripError extends Error {
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message);
    this.name = 'TripError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

const LIMITS = {
  nameMin: 1,
  nameMax: 120,
  destinationNameMax: 200,
  notesMax: 2000,
  maxDays: 60,
  durationMin: 1,
  durationMax: 24 * 60,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── date helpers (UTC-safe) ──────────────────────────────────────────────

// A calendar date as { y, m, d }, or null when the string is not a real ISO
// date. Round-tripping through Date rejects a non-existent day (2025-02-30)
// instead of silently rolling it over.
function parseDate(raw) {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

function daysBetween(a, b) {
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86400000);
}

// Expand an inclusive [start, end] range into one ISO date per day, oldest
// first. Pure and leap-year correct: it adds calendar days, not 24h, so a
// daylight-saving shift never changes the count.
function expandDays(start, end) {
  const from = parseDate(start);
  const to = parseDate(end);
  if (!from || !to) return [];
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const out = [];
  for (let i = 0; i <= span; i += 1) {
    out.push(new Date(Date.UTC(from.y, from.m - 1, from.d + i)).toISOString().slice(0, 10));
  }
  return out;
}

// ── validation ───────────────────────────────────────────────────────────

function cleanText(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function cleanNote(raw) {
  return typeof raw === 'string'
    ? raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';
}

// A destination is optional. When present it is a name chosen through the
// existing search (never a geocoded POI the app cannot verify), with optional
// coordinates that must be in range.
function validateDestination(raw, fields = {}) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    fields.destination = 'The destination is malformed.';
    return null;
  }
  const name = cleanText(raw.name);
  if (!name) {
    fields.destination = 'Give the destination a name.';
    return null;
  }
  if (name.length > LIMITS.destinationNameMax) {
    fields.destination = 'Destination names are limited to ' + LIMITS.destinationNameMax + ' characters.';
    return null;
  }
  const hasLat = raw.lat != null && raw.lat !== '';
  const hasLng = raw.lng != null && raw.lng !== '';
  if (hasLat || hasLng) {
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (
      !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180
    ) {
      fields.destination = 'The destination coordinates are out of range.';
      return null;
    }
    return { name, lat, lng };
  }
  return { name, lat: null, lng: null };
}

// A place snapshot stored with an itinerary item: the display-only summary
// chosen from search (name/category/address), plus optional coordinates. It
// is never provider detail, and it is never rendered as fresh provider data.
function validatePlaceSnapshot(raw, fields = {}) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    fields.place = 'The place summary is malformed.';
    return null;
  }
  const name = cleanText(raw.name);
  if (!name) {
    fields.place = 'The place summary needs a name.';
    return null;
  }
  const out = { name: name.slice(0, LIMITS.destinationNameMax) };
  if (typeof raw.category === 'string' && raw.category) out.category = cleanText(raw.category).slice(0, 120);
  if (typeof raw.subcategory === 'string' && raw.subcategory) out.subcategory = cleanText(raw.subcategory).slice(0, 120);
  if (typeof raw.address === 'string' && raw.address) out.address = cleanText(raw.address).slice(0, 300);
  if (raw.coordinates && typeof raw.coordinates === 'object') {
    const lat = Number(raw.coordinates.lat);
    const lng = Number(raw.coordinates.lng != null ? raw.coordinates.lng : raw.coordinates.lon);
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180) {
      out.coordinates = { lat, lng };
    }
  }
  return out;
}

// Validate a trip body (create, or the merged result of an edit). Returns
// cleaned { name, destination, startDate, endDate } or throws a TripError
// carrying per-field messages the form shows next to each input.
function validateTrip(input) {
  const fields = {};
  const body = input && typeof input === 'object' ? input : {};

  const name = cleanText(body.name);
  if (!name) fields.name = 'Give your trip a name.';
  else if (name.length > LIMITS.nameMax) {
    fields.name = 'Trip names are limited to ' + LIMITS.nameMax + ' characters.';
  }

  const destination = validateDestination(body.destination, fields);

  const start = typeof body.startDate === 'string' ? body.startDate : '';
  const end = typeof body.endDate === 'string' ? body.endDate : '';
  const parsedStart = parseDate(start);
  const parsedEnd = parseDate(end);
  if (!parsedStart) fields.dates = 'Choose a valid start date.';
  else if (!parsedEnd) fields.dates = 'Choose a valid end date.';
  else if (daysBetween(parsedStart, parsedEnd) < 0) {
    fields.dates = 'The end date must be on or after the start date.';
  } else if (daysBetween(parsedStart, parsedEnd) + 1 > LIMITS.maxDays) {
    fields.dates = 'Trips can span at most ' + LIMITS.maxDays + ' days.';
  }

  if (Object.keys(fields).length) {
    throw new TripError('invalid_trip', 'Some details need fixing.', { fields });
  }
  return { name, destination, startDate: start, endDate: end };
}

// Validate an item add/edit body. `partial` (an edit) validates only the keys
// present; a create validates the whole shape. Throws a TripError with
// per-field messages; otherwise returns the cleaned fields.
function validateItem(raw, { partial = false } = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  const out = {};

  if (!partial || 'placeId' in body) {
    const placeId = typeof body.placeId === 'string' ? body.placeId.trim() : '';
    if (!placeId) fields.placeId = 'Choose a place for this stop.';
    else if (placeId.length > 300) fields.placeId = 'That place id is too long.';
    else out.placeId = placeId;
  }

  if (!partial || 'placeSnapshot' in body) {
    const snapshot = validatePlaceSnapshot(body.placeSnapshot, fields);
    if ('placeId' in body || snapshot) out.placeSnapshot = snapshot;
  }

  if (!partial || 'startTime' in body) {
    if (body.startTime == null || body.startTime === '') out.startTime = null;
    else if (typeof body.startTime !== 'string' || !TIME_RE.test(body.startTime.trim())) {
      fields.startTime = 'Use a 24-hour time like 09:30.';
    } else out.startTime = body.startTime.trim();
  }

  if (!partial || 'durationMinutes' in body) {
    if (body.durationMinutes == null || body.durationMinutes === '') out.durationMinutes = null;
    else {
      const n = Number(body.durationMinutes);
      if (!Number.isInteger(n) || n < LIMITS.durationMin || n > LIMITS.durationMax) {
        fields.durationMinutes = 'Enter a duration between 1 and 1440 minutes.';
      } else out.durationMinutes = n;
    }
  }

  if (!partial || 'notes' in body) {
    const notes = cleanNote(body.notes);
    if (notes.length > LIMITS.notesMax) {
      fields.notes = 'Notes are limited to ' + LIMITS.notesMax + ' characters.';
    } else out.notes = notes || null;
  }

  if (Object.keys(fields).length) {
    throw new TripError('invalid_item', 'Some details need fixing.', { fields });
  }
  return out;
}

// ── array math (shared by the store and the screen) ──────────────────────

// Move within one day's item list. Returns a NEW array; an out-of-range index
// leaves the list unchanged. The screen previews reorder with this before the
// server confirms it, and node:test drives it directly.
function moveWithin(items, from, to) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);
  return list;
}

// Move an item from one day's list into another day's list at `to`, clamping
// the target into range. Returns { fromList, toList } as new arrays.
function moveBetween(fromItems, toItems, from, to) {
  const source = Array.isArray(fromItems) ? fromItems.slice() : [];
  const dest = Array.isArray(toItems) ? toItems.slice() : [];
  if (from < 0 || from >= source.length) return { fromList: source, toList: dest };
  const clamped = Math.max(0, Math.min(dest.length, to));
  const [moved] = source.splice(from, 1);
  dest.splice(clamped, 0, moved);
  return { fromList: source, toList: dest };
}

// Normalize a per-day index: the store clamps into the target day rather than
// refusing, so a stale client cannot break an order.
function clampIndex(index, length) {
  const n = Number(index);
  if (!Number.isFinite(n)) return length;
  return Math.max(0, Math.min(length, Math.trunc(n)));
}

// ── ids ──────────────────────────────────────────────────────────────────

// A trip/day/item id is a positive integer string. Anything else is a 404,
// never a 500, so a malformed deep link reads as "does not exist".
function parseId(raw, message) {
  if (typeof raw !== 'string' || !/^\d{1,18}$/.test(raw) || raw === '0') {
    throw new TripError('not_found', message, { status: 404 });
  }
  return raw;
}

function parseTripId(raw) {
  return parseId(raw, 'That trip does not exist.');
}

function parseDayId(raw) {
  return parseId(raw, 'That day does not exist.');
}

function parseItemId(raw) {
  return parseId(raw, 'That stop does not exist.');
}

module.exports = {
  TripError,
  LIMITS,
  parseDate,
  daysBetween,
  expandDays,
  cleanText,
  cleanNote,
  validateDestination,
  validatePlaceSnapshot,
  validateTrip,
  validateItem,
  moveWithin,
  moveBetween,
  clampIndex,
  parseTripId,
  parseDayId,
  parseItemId,
};
