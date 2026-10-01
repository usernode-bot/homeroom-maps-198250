// Photon adapter — the app's DEFAULT search provider.
//
// Photon (komoot) is an open-source geocoder over OpenStreetMap data served
// by OpenSearch, built for autocomplete with strong fuzzy (typo-tolerant)
// matching. The public demo server (photon.komoot.io) is free and needs no
// key, which is why the app ships working without any secret; its soft
// "reasonable use" policy is honoured via the shared token bucket, the
// response cache and the client's debounce+abort (see search/rate-limit.js).
// A self-hosted instance replaces it through PHOTON_URL alone.
//
// Photon's `lang` parameter covers de/en/fr/it. Other locales are sent
// without the parameter and get the local-script name as primary — the app
// never translates a name itself.
//
// Provider response shape (GeoJSON FeatureCollection):
//   features[].geometry.coordinates = [lon, lat]
//   features[].properties = { name, osm_id, osm_type ('N'|'W'|'R'),
//     osm_key, osm_value, country, countrycode, state, county, city,
//     postcode, street, housenumber, district, ... }
//
// TODO(provider-parity): Photon has no reverse-geocoding need here yet;
// its /reverse endpoint maps naturally onto a later map-phase feature.
'use strict';

const { searchError } = require('../provider');
const { normalizeResult, detailLine, KIND_LABELS } = require('../normalize');

const DEFAULT_TIMEOUT_MS = 4000;

// Photon's supported `lang` values (from its API docs).
const SUPPORTED_LANGS = new Set(['de', 'en', 'fr', 'it']);

// Photon reports a category as (osm_key, osm_value). Map to the normalized
// kinds; anything unmapped falls through to 'other' by normalizeResult.
const KIND_MAP = {
  // Administrative places.
  'place:country': 'country',
  'place:state': 'region',
  'place:region': 'region',
  'place:county': 'region',
  'place:city': 'city',
  'place:town': 'town',
  'place:village': 'village',
  'place:hamlet': 'village',
  'place:suburb': 'suburb',
  'place:quarter': 'suburb',
  'place:neighbourhood': 'suburb',
  // Streets: any highway classification is a street result.
  'highway:*': 'street',
  // Addresses.
  'building:*': 'address',
  'addr:housenumber:*': 'address',
  'addr:street:*': 'address',
  // Landmarks: heritage, monuments, sights.
  'historic:*': 'landmark',
  'tourism:*': 'landmark',
  // Points of interest: everyday venues.
  'amenity:*': 'poi',
  'shop:*': 'poi',
  'leisure:*': 'poi',
  'office:*': 'poi',
  'craft:*': 'poi',
};

function mapKind(osmKey, osmValue) {
  const exact = KIND_MAP[`${osmKey}:${osmValue}`];
  if (exact) return exact;
  const wildcard = KIND_MAP[`${osmKey}:*`];
  if (wildcard) return wildcard;
  return 'other';
}

// A URL-safe identifier for a result. Photon features carry an OSM id in
// practice; a coordinate fallback keeps ids stable-enough for recents even
// when one is missing.
function resultId(p, lon, lat) {
  if (p.osm_id) {
    const type = { N: 'node', W: 'way', R: 'relation' }[p.osm_type] || 'place';
    return `photon:osm.${type}.${p.osm_id}`;
  }
  return `photon:${lon},${lat}`;
}

// Compose the displayable address line from Photon's structured fields in
// their conventional order. Photon supplies no pre-formatted line, so this
// is assembled from the provider's own fields (not a rearrangement of a
// formatted line the provider gave us).
function addressLineOf(p, name) {
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  const postcodeCity = [p.postcode, p.city].filter(Boolean).join(' ');
  const parts = [streetLine, postcodeCity, p.state, p.country]
    .filter((part, i, all) => part && all.indexOf(part) === i && part !== name);
  return parts.join(', ') || null;
}

function normalizeFeature(feature, providerName) {
  const p = (feature && feature.properties) || {};
  const coords = (feature && feature.geometry && feature.geometry.coordinates) || [];
  const lon = coords[0];
  const lat = coords[1];
  if (!p.name || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const kind = mapKind(p.osm_key, p.osm_value);
  const isAddress = kind === 'address' || kind === 'street';
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  const detail = detailLine(KIND_LABELS[kind], isAddress
    ? [streetLine, [p.postcode, p.city].filter(Boolean).join(' '), p.state, p.country]
    : [p.city, p.county, p.state, p.country]);

  return normalizeResult({
    id: resultId(p, lon, lat),
    kind,
    name: p.name,
    localName: null, // Photon returns one name per request; no local variant
    detail,
    address: {
      houseNumber: p.housenumber || null,
      street: p.street || null,
      city: p.city || null,
      state: p.state || null,
      postcode: p.postcode || null,
      country: p.country || null,
      countryCode: p.countrycode || null,
    },
    addressLine: addressLineOf(p, p.name),
    lat,
    lon,
    provider: providerName,
  });
}

function createPhoton({ url, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url) throw new Error('createPhoton needs a base URL.');

  // Only search mode carries the map-area and nearby bias (see the spec);
  // suggest stays a plain typeahead.
  function buildUrl({ q, limit, lang, bbox, near }, mode) {
    const u = new URL('/api', url);
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(limit));
    const sub = (lang && lang.split('-')[0].toLowerCase()) || '';
    if (SUPPORTED_LANGS.has(sub)) u.searchParams.set('lang', sub);
    if (mode === 'search' && bbox) u.searchParams.set('bbox', bbox.join(','));
    if (mode === 'search' && near) {
      // Photon's lat/lon bias is strongest with the scale parameter omitted:
      // empirically, sending location_bias_scale on the public instance
      // WEAKENS the bias, so the nearby query relies on plain lat/lon.
      u.searchParams.set('lat', String(near.lat));
      u.searchParams.set('lon', String(near.lon));
    }
    return u.toString();
  }

  async function request(params, mode) {
    let res;
    try {
      res = await fetchImpl(buildUrl(params, mode), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw searchError('provider_error', 'The search provider did not answer in time.');
      }
      if (err && err.name === 'TimeoutError') {
        throw searchError('provider_error', 'The search provider did not answer in time.');
      }
      throw searchError('provider_error', 'The search provider could not be reached.');
    }
    if (!res.ok) {
      throw searchError(
        'provider_error',
        `The search provider answered with status ${res.status}.`,
      );
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw searchError('provider_error', 'The search provider sent an unreadable answer.');
    }
    const features = Array.isArray(body && body.features) ? body.features : [];
    return features
      .map((f) => normalizeFeature(f, 'photon'))
      .filter(Boolean);
  }

  return {
    name: 'photon',
    public: true, // free public endpoint -> the shared token bucket applies
    supportsSuggest: true,
    isConfigured() {
      return Boolean(url);
    },
    suggest(params) {
      return request(params, 'suggest');
    },
    search(params) {
      return request(params, 'search');
    },
  };
}

module.exports = { createPhoton };