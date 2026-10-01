// Nominatim adapter — implemented but NOT the default.
//
// The public OSM instance serves worldwide search free, but its usage policy
// FORBIDS autocomplete ("auto-complete search ... must not be implemented via
// the API") and caps the app at an aggregate 1 request per second. So this
// adapter declares supportsSuggest: false: a suggest call throws
// not_configured rather than quietly routing autocomplete through the search
// endpoint to evade the policy. It is a legitimate fallback for committed
// searches (Enter-pressed lookups) if the app is ever pointed at it.
//
// Provider response shape (format=jsonv2):
//   [{ place_id, osm_type, osm_id, category (class), type, addresstype,
//      display_name, name, namedetails (with namedetails=1),
//      address (with addressdetails=1), lat, lon, importance }]
//
// Policy compliance details: a custom identifying User-Agent (stock library
// User-Agents are banned), accept-language for result language, and viewbox
// in Nominatim's own left/top/right/bottom ordering.
'use strict';

const { searchError } = require('../provider');
const { normalizeResult, detailLine, KIND_LABELS, primarySubtag } = require('../normalize');

const DEFAULT_TIMEOUT_MS = 4000;

// Identifies this app to the endpoint, as the usage policy requires. Header
// only; never baked into a URL or shown to the client.
const USER_AGENT = 'HomeroomMaps/1.0 (Homeroom Maps app)';

function mapKind(category, addresstype) {
  if (addresstype === 'house' || category === 'building' || category === 'addr:housenumber') {
    return 'address';
  }
  if (category === 'highway') return 'street';
  if (category === 'place') {
    const byType = {
      country: 'country',
      state: 'region',
      region: 'region',
      county: 'region',
      city: 'city',
      town: 'town',
      village: 'village',
      hamlet: 'village',
      suburb: 'suburb',
      quarter: 'suburb',
      neighbourhood: 'suburb',
    };
    return byType[addresstype] || 'other';
  }
  if (category === 'tourism' || category === 'historic') return 'landmark';
  if (['amenity', 'shop', 'leisure', 'office', 'craft'].includes(category)) return 'poi';
  return 'other';
}

function normalizeElement(el, providerName, lang) {
  if (!el || el.lat == null || el.lon == null) return null;
  const details = el.namedetails || {};
  const sub = primarySubtag(lang);
  // Best name in the requested language, else the place's default name, else
  // the formatted fallback. The app never translates names itself.
  const name =
    (sub && details[`name:${sub}`]) || details.name || el.name || el.display_name;
  const localName = details.name && details.name !== name ? details.name : null;
  const kind = mapKind(el.category, el.addresstype);
  const a = el.address || {};
  const city = a.city || a.town || a.village || a.municipality || null;
  const isAddress = kind === 'address' || kind === 'street';
  const streetLine = [a.house_number, a.road].filter(Boolean).join(' ');
  const detail = detailLine(KIND_LABELS[kind], isAddress
    ? [streetLine, [a.postcode, city].filter(Boolean).join(' '), a.state, a.country]
    : [city, a.county, a.state, a.country]);

  const id = el.osm_type && el.osm_id
    ? `nominatim:osm.${el.osm_type}.${el.osm_id}`
    : `nominatim:${el.place_id}`;
  return normalizeResult({
    id,
    kind,
    name,
    localName,
    detail,
    address: {
      houseNumber: a.house_number || null,
      street: a.road || null,
      city,
      state: a.state || null,
      postcode: a.postcode || null,
      country: a.country || null,
      countryCode: a.country_code || null,
    },
    // display_name is the provider's own formatted line — rendered verbatim,
    // local ordering preserved.
    addressLine: el.display_name || null,
    lat: Number(el.lat),
    lon: Number(el.lon),
    provider: providerName,
  });
}

function createNominatim({ url, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url) throw new Error('createNominatim needs a base URL.');

  function buildUrl({ q, limit, bbox }) {
    const u = new URL('/search', url);
    u.searchParams.set('q', q);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('addressdetails', '1');
    u.searchParams.set('namedetails', '1');
    u.searchParams.set('limit', String(limit));
    // Nominatim viewbox order is left,top,right,bottom:
    // minLon, maxLat, maxLon, minLat. `bounded=1` restricts rather than biases.
    if (bbox) {
      u.searchParams.set('viewbox', [bbox[0], bbox[3], bbox[2], bbox[1]].join(','));
      u.searchParams.set('bounded', '1');
    }
    return u.toString();
  }

  async function search(params) {
    let res;
    try {
      res = await fetchImpl(buildUrl(params), {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(params.lang ? { 'Accept-Language': params.lang } : {}),
        },
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
    const elements = Array.isArray(body) ? body : [];
    return elements.map((e) => normalizeElement(e, 'nominatim', params.lang)).filter(Boolean);
  }

  return {
    name: 'nominatim',
    public: true,
    supportsSuggest: false, // autocomplete via this API is banned by policy
    isConfigured() {
      return Boolean(url);
    },
    suggest() {
      throw searchError(
        'not_configured',
        'The Nominatim provider does not support autocomplete suggestions.',
      );
    },
    search,
  };
}

module.exports = { createNominatim };