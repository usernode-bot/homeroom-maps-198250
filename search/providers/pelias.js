// Pelias adapter — implemented but configured ONLY when PELIAS_URL is set.
//
// Pelias (MIT, by the Geocode Earth team) is the app's no-lock-in escape
// hatch: a self-hosted instance needs its own Elasticsearch, so it is not the
// default, but pointing the app at a self-host or the hosted Geocode Earth
// service is a config change (PELIAS_URL, optional PELIAS_API_KEY), never a
// code change. It has first-class autocomplete and the strongest multilingual
// name support of the open options (Who's on First carries per-language
// names), so it is also the documented upgrade path for multilingual depth.
//
// Provider response shape (GeoJSON FeatureCollection):
//   features[].geometry.coordinates = [lon, lat]
//   features[].properties = { id, layer ('country'|'region'|'county'|
//     'locality'|'neighbourhood'|'street'|'address'|'venue'|'postalcode'|
//     'coarse'), name: { default, <lang>, ... } | string, country,
//     country_a, region, county, locality, neighbourhood, street,
//     housenumber, postalcode }
'use strict';

const { searchError } = require('../provider');
const { normalizeResult, detailLine, KIND_LABELS, primarySubtag } = require('../normalize');

const DEFAULT_TIMEOUT_MS = 4000;

const LAYER_KINDS = {
  country: 'country',
  dependency: 'country',
  region: 'region',
  county: 'region',
  localadmin: 'region',
  locality: 'city',
  localgovernance: 'city',
  borough: 'suburb',
  neighbourhood: 'suburb',
  street: 'street',
  address: 'address',
  venue: 'poi',
  postalcode: 'other',
  coarse: 'other',
};

// Pelias carries per-language names; pick the requested language, keep the
// default (usually the local-script name) for the secondary display.
function pickNames(p, lang) {
  const name = p.name;
  if (name == null) return { name: null, localName: null };
  if (typeof name === 'string') return { name, localName: null };
  const sub = primarySubtag(lang);
  const localized = (sub && name[sub]) || name.default || null;
  const local = name.default || null;
  return { name: localized, localName: local && local !== localized ? local : null };
}

function normalizeFeature(feature, providerName, lang) {
  const p = (feature && feature.properties) || {};
  const coords = (feature && feature.geometry && feature.geometry.coordinates) || [];
  const lon = coords[0];
  const lat = coords[1];
  const { name, localName } = pickNames(p, lang);
  if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const kind = LAYER_KINDS[p.layer] || 'other';
  const isAddress = kind === 'address' || kind === 'street';
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  const detail = detailLine(KIND_LABELS[kind], isAddress
    ? [streetLine, [p.postcode, p.locality].filter(Boolean).join(' '), p.region, p.country]
    : [p.locality, p.county, p.region, p.country]);

  // Pelias supplies no pre-formatted line; compose from its own fields.
  const streetLineFull = [p.housenumber, p.street].filter(Boolean).join(' ');
  const parts = [streetLineFull, p.locality, p.region, p.country]
    .filter((part, i, all) => part && all.indexOf(part) === i && part !== name);
  return normalizeResult({
    id: p.id ? `pelias:${p.id}` : `pelias:${lon},${lat}`,
    kind,
    name,
    localName,
    detail,
    address: {
      houseNumber: p.housenumber || null,
      street: p.street || null,
      city: p.locality || null,
      state: p.region || null,
      postcode: p.postalcode || null,
      country: p.country || null,
      countryCode: p.country_a || null,
    },
    addressLine: parts.join(', ') || null,
    lat,
    lon,
    provider: providerName,
  });
}

function createPelias({ url, apiKey = '', fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  function buildUrl({ q, limit, lang, bbox, near }, endpoint) {
    const u = new URL(`/v1/${endpoint}`, url);
    u.searchParams.set('text', q);
    u.searchParams.set('size', String(limit));
    if (apiKey) u.searchParams.set('api_key', apiKey);
    if (lang) u.searchParams.set('lang', lang);
    if (near) {
      u.searchParams.set('focus.point.lat', String(near.lat));
      u.searchParams.set('focus.point.lon', String(near.lon));
      u.searchParams.set('boundary.circle.radius', String(near.radiusKm));
    }
    if (bbox) {
      u.searchParams.set('boundary.rect.min_lon', String(bbox[0]));
      u.searchParams.set('boundary.rect.min_lat', String(bbox[1]));
      u.searchParams.set('boundary.rect.max_lon', String(bbox[2]));
      u.searchParams.set('boundary.rect.max_lat', String(bbox[3]));
    }
    return u.toString();
  }

  async function request(params, endpoint) {
    let res;
    try {
      res = await fetchImpl(buildUrl(params, endpoint), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
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
    return features.map((f) => normalizeFeature(f, 'pelias', params.lang)).filter(Boolean);
  }

  return {
    name: 'pelias',
    public: false, // self-hosted or a paid hosted plan -> no shared bucket
    supportsSuggest: true,
    isConfigured() {
      return Boolean(url);
    },
    suggest(params) {
      return request(params, 'autocomplete');
    },
    search(params) {
      return request(params, 'search');
    },
  };
}

module.exports = { createPelias };