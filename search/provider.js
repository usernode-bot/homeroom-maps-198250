// The SearchProvider contract and the provider registry.
//
// An adapter turns one geocoder's response shape into the app's normalized
// SearchResult. Nothing above the adapter layer may read a provider-specific
// field, so switching providers is a config change (`SEARCH_PROVIDER`), never
// a UI change. Every adapter exports:
//
//   {
//     name,            // stable identifier, matches SEARCH_PROVIDER values
//     public,          // true when the endpoint is a free public instance that
//                      // the shared rate limiter must protect
//     isConfigured(),  // false when a required URL/key is missing
//     supportsSuggest, // false when the provider forbids autocomplete
//     suggest(query),  // -> SearchResult[]   (normalized, see normalize.js)
//     search(query),   // -> SearchResult[]
//   }
//
// Adapter failures throw the typed errors from searchError() below; the HTTP
// layer in server.js maps each code to its status. An adapter returns results
// ONLY from its provider's actual response: an empty provider answer is an
// empty array, never a fallback list, and an unconfigured adapter throws
// rather than returning anything at all.
'use strict';

// Typed error codes shared by every layer. server.js maps:
//   invalid_query -> 400, not_configured -> 501, rate_limited -> 429,
//   everything else -> 502 (provider_error).
function searchError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const registry = new Map();

function register(provider) {
  registry.set(provider.name, provider);
}

function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) {
    throw searchError(
      'not_configured',
      `Unknown search provider "${name}". Configure SEARCH_PROVIDER with one of: ` +
        [...registry.keys()].join(', ') + '.',
    );
  }
  return provider;
}

function providerNames() {
  return [...registry.keys()];
}

module.exports = { searchError, register, getProvider, providerNames };