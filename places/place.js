// The normalized, provider-independent Place model — the server-side twin of
// the frontend's places-model.js.
//
// Everything here is synchronous and I/O-free so it is fully unit-testable
// (tests/places.normalize.test.js). A PlaceProvider adapter (places/provider.js)
// maps its provider's response into a partial place; normalizePlace() is the
// LAST step before a place leaves this module, so the shape documented below
// is the only shape the HTTP routes and the UI ever see — no provider-specific
// field can leak past it.
//
//   {
//     id,                 // required, stable within the provider
//     name,               // required, display name
//     localizedNames,     // { lang-tag: name } or null — provider-supplied only
//     category,           // broad kind ('locality', 'restaurant', …) or null
//     subcategory,        // narrower kind ('city', 'bakery', …) or null
//     coordinates,        // { lat, lon } clamped to valid ranges, or null —
//                         // absence is a real state the UI renders
//     address,            // one formatted line, or null
//     country,            // display name, or null
//     phone, website,     // strings or null; website kept only with a scheme
//     openingHours,       // { status, weekdayText } or null. `status` is one of
//                         // 'open' | 'closed' | 'opening_later' | 'closing_later'
//                         // and comes ONLY from provider data (an explicit
//                         // status or the provider's own open-now boolean) —
//                         // it is never computed from weekdayText or the clock.
//     rating,             // { value (0 < value <= 5), count (integer >= 0) or null } or null
//     photos,             // [{ id, url, width, height, attribution }] — entries
//                         // without an http(s) URL are dropped, never repaired
//     businessStatus,     // 'operational' | 'closed_temporarily' |
//                         // 'closed_permanently' | 'coming_soon' | null
//     verificationStatus, // 'verified' | 'unverified' | 'pending' | null
//     dataSource,         // provider name; 'unknown' when the adapter sent none
//   }
//
// Every optional field is filled with null (photos: []) so the UI never reads
// undefined off a place. Missing or invalid data is dropped, not invented:
// a place with no rating has rating: null, and nothing anywhere fills it in.
'use strict';

const OPENING_STATUSES = new Set(['open', 'closed', 'opening_later', 'closing_later']);
const BUSINESS_STATUSES = new Set([
  'operational',
  'closed_temporarily',
  'closed_permanently',
  'coming_soon',
]);
const VERIFICATION_STATUSES = new Set(['verified', 'unverified', 'pending']);

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Lower-case an enum-ish value and keep it only when it is a known one, so
// provider casing ("OPERATIONAL") maps without inventing new states.
function normalizeEnum(value, allowed) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(s) ? s : null;
}

function normalizeCoordinates(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function normalizeLocalizedNames(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [tag, name] of Object.entries(raw)) {
    const key = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
    const value = typeof name === 'string' ? name.trim() : '';
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// Website URLs are kept only when they carry a scheme; prefixing one to a bare
// host would risk pointing users at a guess, which is worse than no link.
function normalizeWebsite(raw) {
  const url = str(raw);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

// `openNow` is the provider's own boolean (e.g. a Places-API open_now field),
// translated to a status — a translation of real data, not a computation.
// weekdayText is rendered rows from the provider, shown verbatim.
function normalizeOpeningHours(raw, openNow) {
  let status = null;
  if (raw && typeof raw === 'object') status = normalizeEnum(raw.status, OPENING_STATUSES);
  if (!status && openNow === true) status = 'open';
  else if (!status && openNow === false) status = 'closed';
  let weekdayText = null;
  if (raw && Array.isArray(raw.weekdayText)) {
    const rows = raw.weekdayText
      .map((row) => (typeof row === 'string' && row.trim() ? row.trim() : null))
      .filter(Boolean);
    if (rows.length) weekdayText = rows;
  }
  if (!status && !weekdayText) return null;
  return { status, weekdayText };
}

function normalizeRating(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = Number(raw.value);
  if (!Number.isFinite(value) || value <= 0 || value > 5) return null;
  const count = Number(raw.count);
  return { value, count: Number.isInteger(count) && count >= 0 ? count : null };
}

function normalizePhotos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const url = str(entry.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const width = Number(entry.width);
    const height = Number(entry.height);
    out.push({
      id: str(entry.id),
      url,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      attribution: str(entry.attribution),
    });
  }
  return out;
}

// Final guard over one place. Returns null for anything unusable (adapters
// skip those entries silently) and fills every optional field.
function normalizePlace(partial) {
  if (!partial || typeof partial !== 'object') return null;
  const id = str(partial.id);
  const name = str(partial.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    localizedNames: normalizeLocalizedNames(partial.localizedNames),
    category: str(partial.category),
    subcategory: str(partial.subcategory),
    coordinates: normalizeCoordinates(partial.coordinates),
    address: str(partial.address),
    country: str(partial.country),
    phone: str(partial.phone),
    website: normalizeWebsite(partial.website),
    openingHours: normalizeOpeningHours(partial.openingHours, partial.openNow),
    rating: normalizeRating(partial.rating),
    photos: normalizePhotos(partial.photos),
    businessStatus: normalizeEnum(partial.businessStatus, BUSINESS_STATUSES),
    verificationStatus: normalizeEnum(partial.verificationStatus, VERIFICATION_STATUSES),
    dataSource: str(partial.dataSource) || 'unknown',
  };
}

// Pure validation of an ALREADY-normalized place: everything normalizePlace
// guarantees, asserted. Returns { ok, problems: [string] } so callers (the
// service between the adapter and the response) can decide what to do without
// exceptions crossing the boundary. Used by the service as a post-condition
// check; tests use it directly.
function validatePlace(place) {
  const problems = [];
  if (!place || typeof place !== 'object') {
    return { ok: false, problems: ['place is not an object'] };
  }
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!s(place.id)) problems.push('id is required');
  if (!s(place.name)) problems.push('name is required');
  if (place.coordinates != null) {
    const c = place.coordinates;
    const lat = Number(c && c.lat);
    const lon = Number(c && c.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      problems.push('coordinates must be finite numbers');
    } else if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      problems.push('coordinates are out of range');
    }
  }
  if (place.rating != null) {
    const value = Number(place.rating && place.rating.value);
    if (!Number.isFinite(value) || value <= 0 || value > 5) {
      problems.push('rating.value must be within (0, 5]');
    }
    const count = place.rating && place.rating.count;
    if (count != null && (!Number.isInteger(count) || count < 0)) {
      problems.push('rating.count must be a non-negative integer');
    }
  }
  if (place.photos != null) {
    if (!Array.isArray(place.photos)) problems.push('photos must be an array');
    else {
      place.photos.forEach((photo, i) => {
        const url = photo && s(photo.url);
        if (!url || !/^https?:\/\//i.test(url)) problems.push(`photos[${i}] needs an http(s) URL`);
      });
    }
  }
  if (place.openingHours != null) {
    const status = place.openingHours && place.openingHours.status;
    if (status != null && !OPENING_STATUSES.has(status)) {
      problems.push('openingHours.status is not a known status');
    }
  }
  if (place.businessStatus != null && !BUSINESS_STATUSES.has(place.businessStatus)) {
    problems.push('businessStatus is not a known status');
  }
  if (place.verificationStatus != null && !VERIFICATION_STATUSES.has(place.verificationStatus)) {
    problems.push('verificationStatus is not a known status');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  OPENING_STATUSES,
  BUSINESS_STATUSES,
  VERIFICATION_STATUSES,
  normalizePlace,
  validatePlace,
};