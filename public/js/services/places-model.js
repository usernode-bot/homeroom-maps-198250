// Places model — the client-side, provider-independent Place helpers, and the
// DOCUMENTED Search→Places interface (Phase 3).
//
// Everything here is pure and import-free, so node:test drives it directly
// (tests/places.client.test.js). DOM components (place-card.js, the Discover
// screen and the Place Detail view) render strictly from what these helpers
// return; nothing invents a value the data does not carry.
//
// ---- The Search→Places interface ----
//
// Phase 2's search stack (services/search.js, server search/) finds
// candidates worldwide: countries, cities, streets, addresses, POIs. A search
// result is a SUMMARY, not a full place: it has a name, coordinates, address
// lines and a provider tag, and nothing more (no photos, hours, contact or
// rating). The interface between the two phases is:
//
//   1. placeFromSearchResult(result, { reference }) — maps a normalized
//      SearchResult into the Place model at summary depth. `reference`
//      ({ lat, lon }) optionally attaches a display-only `distanceKm`
//      (geometry between two known points; never a fabricated field).
//   2. The place's `id` is the key into per-place depth: fetchPlace(id)
//      (services/places.js) asks the server's PlaceService for the full
//      place. With no place provider configured (the state this phase ships
//      in) that call answers not_configured, and the UI renders honest
//      "Not available" states instead of the missing depth.
//   3. mergePlace(summary, details) — overlays a fetched full place onto the
//      summary; real detail wins, summary fields the detail does not carry
//      survive.
//
// The integration point in the existing UI is the Home screen's selection
// hook (`focusSelectedPlace` in screens/home.js), which the map phase wires
// to this adapter; the Discover screen (Phase 3) uses it directly for its
// search-driven place flow. This module deliberately does not import or
// modify any Search-phase module: it consumes only the normalized result
// shape search already guarantees (search/normalize.js).
'use strict';

// The one honest fallback label for a field the data does not carry. Shared
// by the Place Card and every Place Detail section so "not built" and
// "missing" read identically everywhere.
export const NOT_AVAILABLE = 'Not available';

// Search-result kinds (search/normalize.js) mapped to broad Place categories.
// The kind itself is kept as the subcategory: real data, just narrower.
const SEARCH_KIND_CATEGORY = {
  country: 'country',
  region: 'region',
  city: 'locality',
  town: 'locality',
  village: 'locality',
  suburb: 'locality',
  street: 'address',
  address: 'address',
  landmark: 'place',
  poi: 'place',
  other: 'place',
};

// English labels for the search kinds, mirroring the server's KIND_LABELS
// (search/normalize.js) so the client never needs a provider struct to label
// a category row.
const SEARCH_KIND_LABELS = {
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

const BUSINESS_STATUS_LABELS = {
  operational: null, // nothing to act on; the card and detail omit it
  closed_temporarily: 'Temporarily closed',
  closed_permanently: 'Permanently closed',
  coming_soon: 'Opening soon',
};

const VERIFICATION_STATUS_LABELS = {
  verified: 'Verified',
  unverified: 'Unverified',
  pending: 'Verification pending',
};

const OPENING_STATUS_LABELS = {
  open: 'Open now',
  closed: 'Closed now',
  opening_later: 'Opens later',
  closing_later: 'Closes later',
};

// Great-circle distance in kilometres (haversine). Pure geometry between two
// known coordinate pairs; callers attach it to a place only when a reference
// point actually exists.
export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const a1 = toRad(lat1);
  const b1 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a1) * Math.cos(b1) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Human distance for a card row: metres below 1 km, one decimal above.
// Returns null for anything unusable so callers omit the row entirely.
export function distanceLabel(km) {
  if (km == null || km === '') return null; // Number(null) is 0; null is not a distance
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1) return `${Math.round(n * 1000)} m`;
  if (n < 100) return `${n.toFixed(1)} km`;
  return `${Math.round(n)} km`;
}

export function businessStatusLabel(status) {
  return (status && BUSINESS_STATUS_LABELS[status]) || null;
}

export function verificationStatusLabel(status) {
  return (status && VERIFICATION_STATUS_LABELS[status]) || null;
}

export function openingHoursStatusLabel(status) {
  return (status && OPENING_STATUS_LABELS[status]) || null;
}

// The category line: the search kind's label when the place came from search,
// otherwise the provider's own category/subcategory, capitalized. Null when
// nothing real is present, so callers omit the line.
export function categoryLabel(place) {
  if (!place || typeof place !== 'object') return null;
  const sub =
    typeof place.subcategory === 'string' && place.subcategory
      ? SEARCH_KIND_LABELS[place.subcategory] || null
      : null;
  if (sub) return sub;
  const raw =
    (typeof place.category === 'string' && place.category) ||
    (typeof place.subcategory === 'string' && place.subcategory) ||
    null;
  if (!raw) return null;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Rating text: the value to one decimal, or null when absent — never a
// placeholder number, never "no rating yet" fabricated into a value.
export function ratingLabel(rating) {
  if (!rating || typeof rating !== 'object') return null;
  const value = Number(rating.value);
  if (!Number.isFinite(value) || value <= 0 || value > 5) return null;
  return value.toFixed(1);
}

export function ratingCountLabel(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `${n} ratings`;
}

// Compose one address line from a normalized search result's structured
// address (search/normalize.js). Only real parts are joined; empty parts
// drop out. Returns null when there is nothing to show.
function composeAddressLine(address) {
  if (!address || typeof address !== 'object') return null;
  const parts = [
    [address.houseNumber, address.street].filter(Boolean).join(' '),
    [address.postcode, address.city].filter(Boolean).join(' '),
    address.state,
    address.country,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Search result -> Place, summary depth. Returns null for anything unusable
// (no id/name), matching how the search stack treats malformed rows.
export function placeFromSearchResult(result, { reference } = {}) {
  if (!result || typeof result !== 'object') return null;
  const name =
    typeof result.name === 'string' && result.name.trim() ? result.name.trim() : '';
  if (!name) return null;
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  const coordinates =
    Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  const id =
    (typeof result.id === 'string' && result.id.trim()) ||
    (coordinates ? `${lat},${lon}` : '');
  if (!id) return null;
  const localName =
    typeof result.localName === 'string' && result.localName.trim()
      ? result.localName.trim()
      : null;
  // `und` is the BCP-47 undefined-language tag: the search result carries a
  // local-language name without saying which language, and that is exactly
  // what the tag is for. Nothing is guessed.
  const localizedNames = localName ? { und: localName } : null;
  const address = result.addressLine || composeAddressLine(result.address) || null;
  const place = {
    id,
    name,
    localizedNames,
    category: SEARCH_KIND_CATEGORY[result.kind] || 'place',
    subcategory: typeof result.kind === 'string' && result.kind ? result.kind : null,
    coordinates,
    address,
    country: (result.address && result.address.country) || null,
    // Detail depth (phone, website, hours, rating, photos, business and
    // verification status) arrives only from the place provider. A search
    // summary has none of it, and none of it is invented here.
    phone: null,
    website: null,
    openingHours: null,
    rating: null,
    photos: [],
    businessStatus: null,
    verificationStatus: null,
    dataSource:
      typeof result.provider === 'string' && result.provider
        ? result.provider
        : 'unknown',
    // Phase 12B: an offline result carries its own marks so the card can never
    // present device-local data as a live result. Absent on online results.
    offline: Boolean(result.offline),
    regionName:
      typeof result.regionName === 'string' && result.regionName ? result.regionName : null,
    attribution:
      typeof result.attribution === 'string' && result.attribution ? result.attribution : null,
  };
  if (reference && coordinates) {
    const km = distanceKm(reference.lat, reference.lon, coordinates.lat, coordinates.lon);
    if (Number.isFinite(km)) place.distanceKm = km; // display-only, not model data
  }
  return place;
}

// Overlay a fetched full place onto the summary a card/detail was opened
// with. Real detail wins field by field; summary fields the detail does not
// carry survive untouched. Photos: the detail's list when it has one, else
// the summary's. distanceKm is re-derived, never carried stale.
export function mergePlace(summary, details) {
  if (!details || typeof details !== 'object') return summary || null;
  const base = summary || {};
  const pick = (a, b) => (b != null && b !== '' ? b : a != null ? a : null);
  const merged = {
    id: pick(base.id, details.id) || '',
    name: pick(base.name, details.name) || '',
    localizedNames: details.localizedNames || base.localizedNames || null,
    category: pick(base.category, details.category),
    subcategory: pick(base.subcategory, details.subcategory),
    coordinates: details.coordinates || base.coordinates || null,
    address: pick(base.address, details.address),
    country: pick(base.country, details.country),
    phone: pick(base.phone, details.phone),
    website: pick(base.website, details.website),
    openingHours: details.openingHours || base.openingHours || null,
    rating: details.rating || base.rating || null,
    photos:
      Array.isArray(details.photos) && details.photos.length
        ? details.photos
        : Array.isArray(base.photos)
          ? base.photos
          : [],
    businessStatus: pick(base.businessStatus, details.businessStatus),
    verificationStatus: pick(base.verificationStatus, details.verificationStatus),
    dataSource: pick(base.dataSource, details.dataSource) || 'unknown',
    offline: Boolean(base.offline || details.offline),
    regionName: pick(base.regionName, details.regionName),
    attribution: pick(base.attribution, details.attribution),
  };
  if (Number.isFinite(base.distanceKm)) merged.distanceKm = base.distanceKm;
  return merged;
}