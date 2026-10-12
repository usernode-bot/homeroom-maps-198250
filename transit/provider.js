// The TransitProvider contract and the provider registry — the server half of
// the transit abstraction (Phase 12E, stage 1).
//
// An adapter turns one transit data source's response shape into the app's
// normalized TransitStop / TransitRoute types. Nothing above the adapter layer
// may read a provider-specific field, so switching providers is a
// TRANSIT_PROVIDER config change, never a UI change — the same rule the search
// and routing stacks follow. Every adapter exports:
//
//   {
//     name,           // stable identifier, matches TRANSIT_PROVIDER values
//     label,          // human-readable provider name for the UI
//     attribution,    // the data attribution string transit display owes
//     public,         // true when the endpoint is a free public instance the
//                     // shared rate limiter must protect
//     isConfigured(), // false when a required URL/key is missing
//     capabilities,   // { stops, departures, routing, alerts } — only what
//                     // the provider genuinely serves. NEVER trusted on its
//                     // own: the resolver keys on isConfigured() first, so an
//                     // aspirational `true` (the valhalla.js trap) can never
//                     // enable anything.
//     getStops(bounds),          // -> TransitStop[] (normalized)
//     getDepartures(stopId, time),
//     route(origin, destination, time), // -> TransitRoute (normalized)
//   }
//
// Normalized shapes (master spec item 11):
//   TransitStop  { id, name, location: { lat, lng },
//                  routes: [{ id, name, type: 'bus' | 'rail' | 'ferry' }] }
//   TransitRoute { legs: [{ mode, from, to, departure, arrival,
//                           route: { id, name, type } }], duration }
// Every response additionally carries `fetchedAt` and the provider's own data
// timestamp, so staleness is displayable, never guessable.
//
// Adapter failures throw the typed errors from transitError() below; the HTTP
// layer (a future change) maps each code to its status. An adapter returns
// ONLY what its provider actually answered: an empty answer is the honest
// no-coverage state, never a fabricated fallback, and an unconfigured adapter
// throws rather than returning anything at all.
//
// THE REGISTRY SHIPS EMPTY. There is no transit provider, dataset, feed URL or
// credential anywhere in the repository, so no adapter exists to register and
// none may be invented — a sample or fake adapter here would look like
// capability the app does not have. `registry` is exported for tests only:
// tests may register a fake adapter and MUST remove it again, so the shipped
// state stays empty.
'use strict';

// Typed error codes shared by every layer. The HTTP layer maps:
//   not_configured -> 501, rate_limited -> 429, timeout -> 504,
//   everything else -> 502 (provider_error). Same mapping as routing.
function transitError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const registry = new Map();

function register(provider) {
  if (!provider || typeof provider.name !== 'string' || !provider.name.trim()) {
    throw transitError('invalid_request', 'A transit adapter needs a non-empty name.');
  }
  if (typeof provider.isConfigured !== 'function') {
    throw transitError('invalid_request', `The transit adapter "${provider.name}" needs an isConfigured() function.`);
  }
  registry.set(provider.name, provider);
}

function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) {
    throw transitError(
      'not_configured',
      `Unknown transit provider "${name}". No transit adapter is registered yet.` +
        (registry.size ? ` Registered adapters: ${[...registry.keys()].join(', ')}.` : ''),
    );
  }
  return provider;
}

function providerNames() {
  return [...registry.keys()];
}

module.exports = { transitError, register, getProvider, providerNames, registry };
