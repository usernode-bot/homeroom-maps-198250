// Search service — the server-side SearchService.
//
// One entry point, run(mode, params, ctx), that the two HTTP routes call.
// The pipeline per call is, in order:
//
//   validate -> resolve adapter -> configure checks -> rate limit -> cache
//            -> provider adapter -> normalize -> { provider, results }
//
// Typed errors (search/provider.js) propagate to server.js, which maps each
// code to its HTTP status; the client's typed ApiError handling picks the
// messages up unchanged. This module owns no provider-specific knowledge.
'use strict';

const { SEARCH_PROVIDER, PHOTON_URL, PELIAS_URL, PELIAS_API_KEY } = require('../config');
const { register, getProvider, searchError } = require('./provider');
const { validateQuery, parseBbox, parseNear, parseLimit } = require('./normalize');
const { TokenBucket } = require('./rate-limit');
const { SearchCache } = require('./cache');
const { createPhoton } = require('./providers/photon');
const { createNominatim } = require('./providers/nominatim');
const { createPelias } = require('./providers/pelias');
const { createMapbox } = require('./providers/mapbox');
const { createGoogle } = require('./providers/google');
const { createHere } = require('./providers/here');

// One shared bucket for every PUBLIC provider endpoint: aggregate politeness
// toward the free public geocoders, per the usage policies they publish.
const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });

// Result cache: suggestions are cheap and go stale fast, committed searches
// are stable. Per-process; restarts simply empty it.
const cache = new SearchCache({ maxEntries: 500 });

const SUGGEST_TTL_MS = 5 * 60 * 1000;
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;

// Build every adapter once and register it, so getProvider() resolves by
// name. Adapters are pure configuration; none of them contacts its endpoint
// at construction time.
const providers = {
  photon: createPhoton({ url: PHOTON_URL }),
  nominatim: createNominatim({ url: 'https://nominatim.openstreetmap.org' }),
  pelias: createPelias({ url: PELIAS_URL, apiKey: PELIAS_API_KEY }),
  mapbox: createMapbox(),
  google: createGoogle(),
  here: createHere(),
};
for (const provider of Object.values(providers)) {
  register(provider);
}

// The provider name to report in /api/config: the configured active adapter,
// or null when it is a placeholder (mirroring mapProvider: null).
function activeProviderName() {
  try {
    const provider = getProvider(SEARCH_PROVIDER);
    return provider.isConfigured() ? provider.name : null;
  } catch {
    return null;
  }
}

// The single pipeline. `params` are the RAW HTTP query values; `ctx` carries
// the resolved language preference from the request (see server.js).
async function run(mode, params, ctx = {}) {
  if (mode !== 'suggest' && mode !== 'search') {
    throw searchError('invalid_query', 'Unknown search mode.');
  }
  const q = validateQuery(params.q);
  const limit = parseLimit(params.limit, mode === 'suggest' ? 8 : 10);
  const bbox = parseBbox(params.bbox);
  const near = parseNear(params.near, params.radius);
  const lang = params.lang || ctx.lang || null;

  const provider = getProvider(SEARCH_PROVIDER);
  if (!provider.isConfigured()) {
    throw searchError(
      'not_configured',
      `The ${provider.name} search provider is not configured yet.`,
    );
  }
  if (mode === 'suggest' && !provider.supportsSuggest) {
    throw searchError(
      'not_configured',
      'The configured search provider does not support autocomplete suggestions.',
    );
  }

  // Politeness first, per the pipeline order: a full cache would still cost
  // the public endpoint nothing, but the bucket protects burst patterns too.
  if (provider.public) bucket.takeOrThrow();

  const cacheKey = [
    provider.name,
    mode,
    q,
    limit,
    lang || '',
    bbox ? bbox.join(',') : '',
    near ? `${near.lat},${near.lon},${near.radiusKm}` : '',
  ].join('|');
  const cached = cache.get(cacheKey);
  if (cached) {
    return { provider: provider.name, results: cached, cached: true };
  }

  const results = await provider[mode]({ q, limit, bbox, near, lang });
  cache.set(cacheKey, results, mode === 'suggest' ? SUGGEST_TTL_MS : SEARCH_TTL_MS);
  return { provider: provider.name, results, cached: false };
}

module.exports = { run, activeProviderName };