// The PlaceProvider contract and the provider registry — the seam a real
// place-data provider plugs into.
//
// An adapter turns one provider's response shapes into partial places, which
// places/place.js normalizes. Nothing above the adapter layer may read a
// provider-specific field, so switching providers is a config change
// (PLACE_PROVIDER), never a UI change.
//
// PLACEHOLDER(adapter-phase): no adapter is implemented or registered yet, so
// the registry below is empty and every service call answers a typed
// `not_configured` error. Deliberately NO fake or sample provider exists:
// sample POI data would fabricate the exact fields (photos, hours, rating,
// business status) this phase exists to model honestly.
//
// Selection criteria for the provider this registry will gain an adapter for
// (mirrors the dapp.json PLACE_PROVIDER description):
//   1. worldwide coverage of the place types the app surfaces,
//   2. per-place detail depth: photos, opening hours, phone, website, rating,
//   3. licensing that permits storing and displaying results,
//   4. cost at this app's scale,
//   5. the required credential declarable through the platform Secrets UI.
// Every adapter exports:
//
//   {
//     name,             // stable identifier, matches PLACE_PROVIDER values
//     isConfigured(),   // false when a required URL/key is missing
//     getPlaces({ q, near, bbox, limit, lang }),   // -> partial place[] (summaries)
//     getPlaceById(id, { lang }),                  // -> partial place (summary)
//     getPlaceDetails(id, { lang }),               // -> partial place (full:
//                                                  //    photos, hours, contact,
//                                                  //    rating, business status)
//   }
//
// Adapter failures throw the typed errors from placeError() below; the HTTP
// layer in server.js maps each code to its status. An adapter returns results
// ONLY from its provider's actual response: an empty provider answer is an
// empty array, never a fallback list, and an unconfigured adapter throws
// rather than returning anything at all.
'use strict';

// Typed error codes shared by every layer. server.js maps:
//   invalid_query -> 400, not_configured -> 501, rate_limited -> 429,
//   everything else -> 502 (provider_error).
function placeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The one outbound-request helper a implemented adapter shares. Every failure
// becomes a typed provider_error with a message the client can show
// unchanged: timeout/abort, unreachable host, non-OK status (an upstream 429
// is called out honestly — the app's own rate limiting is a separate,
// bucket-level code), and an unreadable body. `fetchImpl` is injectable so
// tests never touch the network.
async function requestJson(url, { headers, timeoutMs, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw placeError('provider_error', 'The place provider did not answer in time.');
    }
    throw placeError('provider_error', 'The place provider could not be reached.');
  }
  if (!res.ok) {
    throw placeError(
      'provider_error',
      res.status === 429
        ? 'The place provider is throttling requests right now.'
        : `The place provider answered with status ${res.status}.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw placeError('provider_error', 'The place provider sent an unreadable answer.');
  }
}

const registry = new Map();

function register(provider) {
  if (!provider || typeof provider.name !== 'string' || !provider.name) {
    throw placeError('provider_error', 'A place provider adapter needs a name.');
  }
  registry.set(provider.name, provider);
}

function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) {
    throw placeError(
      'not_configured',
      `Unknown place provider "${name}". No place provider adapter is implemented yet; ` +
        'set PLACE_PROVIDER once one ships.',
    );
  }
  return provider;
}

function providerNames() {
  return [...registry.keys()];
}

module.exports = { placeError, requestJson, register, getProvider, providerNames };