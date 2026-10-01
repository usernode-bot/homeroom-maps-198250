// Pure normalization and validation helpers for the search service.
//
// Everything here is synchronous and I/O-free so it is fully unit-testable
// (tests/search.normalize.test.js). The adapters call normalizeResult() as
// the LAST step before returning, which guarantees the normalized shape in
// provider.js's contract comment is the only shape that ever leaves this
// module — no provider-specific field can leak past it.
'use strict';

const { searchError } = require('./provider');

const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 1; // server-side floor; the client waits for 2 chars
const MAX_LIMIT = 20;
const MAX_RADIUS_KM = 100;

// English labels for each normalized kind. The UI is English-only, and the
// kind label is folded into the result's `detail` line ("City, Berlin,
// Germany"), so `poi` and `other` both read as "Place" rather than jargon.
const KIND_LABELS = {
  country: 'Country',
  region: 'Region',
  city: 'City',
  town: 'Town',
  village: 'Village',
  suburb: 'Neighbourhood',
  street: 'Street',
  address: 'Address',
  landmark: 'Landmark',
  poi: 'Place',
  other: 'Place',
};

// Phase 9: Indonesian labels for the same kinds. These are hand-maintained
// translations, never machine-generated. They are applied ONLY as a
// post-process over an already-normalized result (localizeDetailLine below)
// when the request resolved to Indonesian — the adapters themselves stay
// language-agnostic and keep folding the English label, exactly as Phase 2
// shipped.
const KIND_LABELS_ID = {
  country: 'Negara',
  region: 'Wilayah',
  city: 'Kota',
  town: 'Kota kecil',
  village: 'Desa',
  suburb: 'Lingkungan',
  street: 'Jalan',
  address: 'Alamat',
  landmark: 'Landmark',
  poi: 'Tempat',
  other: 'Tempat',
};

// Trim and validate a raw query. `q` shorter than the floor after trimming
// (i.e. empty) or longer than MAX_QUERY_LENGTH is a bad request, not an empty
// result — the two are distinguishable states in the UI.
function validateQuery(raw) {
  const q = typeof raw === 'string' ? raw.trim() : '';
  if (q.length < MIN_QUERY_LENGTH) {
    throw searchError('invalid_query', 'Enter a search term.');
  }
  if (q.length > MAX_QUERY_LENGTH) {
    throw searchError('invalid_query', 'Search terms are limited to 200 characters.');
  }
  return q;
}

// Parse `bbox=minLon,minLat,maxLon,maxLat` (the normalized order the client
// sends; adapters translate to their provider's own ordering). Returns null
// when absent, throws invalid_query when malformed or inverted.
function parseBbox(raw) {
  if (raw == null || raw === '') return null;
  const parts = String(raw).split(',').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isFinite(n)) ||
    parts[0] > parts[2] || // minLon > maxLon
    parts[1] > parts[3] // minLat > maxLat
  ) {
    throw searchError('invalid_query', 'The map area is malformed.');
  }
  return parts;
}

// Parse `near=lat,lon` with optional `radius=km` (default 10, clamped to a
// sane "nearby" range). Returns null when absent.
function parseNear(rawNear, rawRadius) {
  if (rawNear == null || rawNear === '') return null;
  const parts = String(rawNear).split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw searchError('invalid_query', 'The location is malformed.');
  }
  let radiusKm = Number(rawRadius);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) radiusKm = 10;
  radiusKm = Math.min(radiusKm, MAX_RADIUS_KM);
  return { lat: parts[0], lon: parts[1], radiusKm };
}

// Parse and clamp the result limit. A non-numeric limit falls back to the
// caller's default rather than erroring, so a stray param never breaks search.
function parseLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

// First BCP-47 tag from an Accept-Language header, or null. Quality values
// are ignored beyond their ordering, which is how the header is specified.
function firstAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return null;
  const first = header.split(',')[0].split(';')[0].trim();
  return /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(first) ? first : null;
}

// Primary language subtag: "pt-BR" -> "pt". Providers that take a bare
// language code get this; unknown codes are dropped by the adapter.
function primarySubtag(lang) {
  if (!lang) return null;
  const sub = String(lang).split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(sub) ? sub : null;
}

// Compose the secondary line from a kind label and provider fields. Empty
// parts are dropped, and a part equal to the previous part (e.g. Photon
// reporting city AND state as "Berlin" for Berlin) collapses, so the line
// stays short and human: "City, Berlin, Germany".
function detailLine(kindLabel, parts) {
  const out = [];
  for (const part of [kindLabel, ...(parts || [])]) {
    if (part == null || part === '') continue;
    if (out.length && out[out.length - 1].toLowerCase() === String(part).toLowerCase()) continue;
    out.push(String(part));
  }
  let line = out.join(', ');
  if (line.length > 140) line = line.slice(0, 137).replace(/,? ?\S*$/, '') + '…';
  return line;
}

// Final guard over one normalized result. Returns null for anything unusable
// (adapters skip those features silently) and fills every optional field, so
// the UI never reads `undefined` off a result. `localName` is null unless it
// genuinely differs from `name` — a repeated name would be noise in the row.
function normalizeResult(partial) {
  if (!partial || typeof partial !== 'object') return null;
  const name = typeof partial.name === 'string' ? partial.name.trim() : '';
  const lat = Number(partial.lat);
  const lon = Number(partial.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const localName =
    typeof partial.localName === 'string' && partial.localName.trim() &&
    partial.localName.trim() !== name
      ? partial.localName.trim()
      : null;
  const a = partial.address || {};
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: String(partial.id || `${lat},${lon}`),
    kind: KIND_LABELS[partial.kind] ? partial.kind : 'other',
    name,
    localName,
    detail: typeof partial.detail === 'string' && partial.detail ? partial.detail : name,
    address: {
      houseNumber: pick(a.houseNumber),
      street: pick(a.street),
      city: pick(a.city),
      state: pick(a.state),
      postcode: pick(a.postcode),
      country: pick(a.country),
      countryCode: pick(a.countryCode),
    },
    addressLine: pick(partial.addressLine) || null,
    lat,
    lon,
    provider: String(partial.provider || 'unknown'),
  };
}

module.exports = {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  MAX_LIMIT,
  MAX_RADIUS_KM,
  KIND_LABELS,
  KIND_LABELS_ID,
  validateQuery,
  parseBbox,
  parseNear,
  parseLimit,
  firstAcceptLanguage,
  primarySubtag,
  detailLine,
  localizeDetailLine,
  normalizeResult,
};

// Phase 9: rewrite the leading kind label of a detail line into the resolved
// request language's label. detailLine folds the kind label FIRST ("City,
// Berlin, Germany"), and falls back to the bare name when there is no label,
// so the rewrite is exact-prefix only: anything that does not start with the
// English label (a provider name, a mid-line match) passes through
// untouched. Only languages with a real hand-maintained table are rewritten;
// every other language, and null, leaves the line exactly as Phase 2 built it.
function localizeDetailLine(detail, kind, lang) {
  if (!detail || !kind) return detail;
  if (primarySubtag(lang) !== 'id') return detail;
  const localized = KIND_LABELS_ID[kind];
  const english = KIND_LABELS[kind];
  if (!localized || !english || localized === english) return detail;
  if (detail === english) return localized;
  if (detail.startsWith(english + ', ')) {
    return localized + detail.slice(english.length);
  }
  return detail;
}