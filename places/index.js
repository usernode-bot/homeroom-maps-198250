// The PlaceService — one entry-point module over the PlaceProvider
// abstraction (places/provider.js).
//
// Public surface: getPlaces, getPlaceById, getPlaceDetails, plus the pure
// normalizePlace / validatePlace re-exported from places/place.js so callers
// import the whole model contract from here.
//
// The pipeline per call is, in order:
//
//   validate params -> resolve adapter -> adapter -> normalizePlace
//                   -> validatePlace -> { provider, results | place }
//
// Typed errors (places/provider.js) propagate to server.js, which maps each
// code to its HTTP status. This module owns no provider-specific knowledge.
//
// PLACEHOLDER(adapter-phase): no adapter is registered yet, so every call
// throws `not_configured` and /api/places answers 501. When an adapter lands,
// it registers itself by name and PLACE_PROVIDER (config.js / dapp.json)
// selects it; nothing in this file or the UI changes.
'use strict';

const { PLACE_PROVIDER } = require('../config');
const { placeError, getProvider, providerNames } = require('./provider');
const { normalizePlace, validatePlace } = require('./place');
// Reuse the search stack's param validation verbatim (same limits, same
// user-facing messages) so /api/places and /api/search behave identically
// for malformed input. Reading a sibling phase's pure helpers adds no
// coupling of behaviour.
const { parseBbox, parseNear, parseLimit, MAX_QUERY_LENGTH } = require('../search/normalize');

const DEFAULT_LIMIT = 10;

// A query is optional when a location (`near`) is present — "places near a
// point" is a legitimate ask — but something to search BY is required.
function parseOptionalQuery(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const q = String(raw).trim();
  if (q.length > MAX_QUERY_LENGTH) {
    throw placeError('invalid_query', 'Search terms are limited to 200 characters.');
  }
  return q;
}

function requireId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) throw placeError('invalid_query', 'A place id is required.');
  return id;
}

// Build a service bound to a provider name. Tests pass `providerName` (and
// register a stub under it) so the pipeline runs without a real adapter.
function createPlaceService({ providerName = PLACE_PROVIDER } = {}) {
  // Resolve the configured adapter or throw the honest not_configured error.
  function resolveProvider() {
    if (!providerName) {
      throw placeError(
        'not_configured',
        'No place provider is connected yet. Place details, photos, hours and ratings arrive when one is configured.',
      );
    }
    const provider = getProvider(providerName);
    if (!provider.isConfigured()) {
      throw placeError(
        'not_configured',
        `The ${provider.name} place provider is not configured yet.`,
      );
    }
    return provider;
  }

  // Search/browse places by a term and/or a location. Returns summaries only.
  async function getPlaces(params = {}, opts = {}) {
    const q = parseOptionalQuery(params.q);
    const near = parseNear(params.near, params.radius);
    if (!q && !near) {
      throw placeError('invalid_query', 'Enter a search term or a location.');
    }
    const bbox = parseBbox(params.bbox);
    const limit = parseLimit(params.limit, DEFAULT_LIMIT);
    const lang = params.lang || null;

    const provider = resolveProvider();
    const partials = await provider.getPlaces({ q, near, bbox, limit, lang }, opts);
    // Drop anything unusable (normalizePlace returns null for it): an adapter
    // row without an id or a name can never become a place the UI renders.
    const results = (Array.isArray(partials) ? partials : [])
      .map(normalizePlace)
      .filter(Boolean);
    return { provider: provider.name, results };
  }

  // Adapter answer -> normalized, validated place. A null normalization or a
  // failed post-condition means an adapter bug or an unknown id, not bad user
  // input: unknown ids surface as not_found, adapter bugs as provider errors.
  function toPlace(partial, providerName) {
    const place = normalizePlace(partial);
    if (!place) {
      throw placeError('not_found', 'No place was found for that id.');
    }
    const check = validatePlace(place);
    if (!check.ok) {
      throw placeError('provider_error', 'The place provider sent an unusable place.');
    }
    return { provider: providerName, place };
  }

  // One place, summary depth (no photos / hours / contact / rating required).
  async function getPlaceById(id, opts = {}) {
    const placeId = requireId(id);
    const lang = (opts && opts.lang) || null;
    const provider = resolveProvider();
    return toPlace(await provider.getPlaceById(placeId, { lang }), provider.name);
  }

  // One place, full depth. Adapters that keep one detail endpoint may omit
  // getPlaceDetails; the service then falls back to getPlaceById and the
  // result simply carries whatever depth that endpoint returns.
  async function getPlaceDetails(id, opts = {}) {
    const placeId = requireId(id);
    const lang = (opts && opts.lang) || null;
    const provider = resolveProvider();
    const fetchDetails = provider.getPlaceDetails || provider.getPlaceById;
    return toPlace(await fetchDetails.call(provider, placeId, { lang }), provider.name);
  }

  return { getPlaces, getPlaceById, getPlaceDetails, normalizePlace, validatePlace };
}

// The name to report in /api/config: the configured adapter when one exists
// and is configured, or null — the explicit, honest "no provider yet" signal,
// mirroring mapProvider: null.
function activeProviderName() {
  try {
    if (!PLACE_PROVIDER) return null;
    const provider = getProvider(PLACE_PROVIDER);
    return provider.isConfigured() ? provider.name : null;
  } catch {
    return null;
  }
}

module.exports = {
  createPlaceService,
  activeProviderName,
  providerNames,
  normalizePlace,
  validatePlace,
};