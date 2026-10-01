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
const { validateQuery, parseBbox, parseNear, parseLimit, localizeDetailLine } = require('./normalize');
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

// Collapse duplicates by normalized id, keeping the first occurrence. Providers
// occasionally return the same feature under slightly different geometry; the
// listbox must show distinct places. Runs at the one choke point every adapter
// passes through, so it covers all providers and future ones.
function dedupeById(results) {
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

// Phase 9: rewrite the leading kind label of each detail line into the
// request's language (only Indonesian has a table; everything else passes
// through unchanged). Applied AFTER the canonical results are cached, so the
// cache stays language-neutral and any language gets its own labels.
function withKindLabels(results, lang) {
  if (!lang) return results;
  return results.map((r) =>
    r && r.detail && r.kind ? { ...r, detail: localizeDetailLine(r.detail, r.kind, lang) } : r,
  );
}

// The single pipeline. `params` are the RAW HTTP query values; `ctx` carries
// the resolved language preference from the request (see server.js). `opts`
// exists for tests only: `providerName` overrides the configured provider so a
// stub can exercise the pipeline without touching the network.
async function run(mode, params, ctx = {}, opts = {}) {
  if (mode !== 'suggest' && mode !== 'search') {
    throw searchError('invalid_query', 'Unknown search mode.');
  }
  const q = validateQuery(params.q);
  const limit = parseLimit(params.limit, mode === 'suggest' ? 8 : 10);
  const bbox = parseBbox(params.bbox);
  const near = parseNear(params.near, params.radius);
  const lang = params.lang || ctx.lang || null;

  const provider = getProvider(opts.providerName || SEARCH_PROVIDER);
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
    return { provider: provider.name, results: withKindLabels(cached, lang), cached: true };
  }

  const raw = dedupeById(await provider[mode]({ q, limit, bbox, near, lang }));
  cache.set(cacheKey, raw, mode === 'suggest' ? SUGGEST_TTL_MS : SEARCH_TTL_MS);
  return { provider: provider.name, results: withKindLabels(raw, lang), cached: false };
}

module.exports = { run, activeProviderName };