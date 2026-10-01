// The RoutingProvider contract and the provider registry (the server half of
// the RoutingService abstraction).
//
// An adapter turns one routing engine's response shape into the app's
// normalized RouteResult (routing/normalize.js). Nothing above the adapter
// layer may read a provider-specific field, so switching providers is a
// `ROUTING_PROVIDER` config change, never a UI change — the same rule the
// search stack follows. Every adapter exports:
//
//   {
//     name,           // stable identifier, matches ROUTING_PROVIDER values
//     label,          // human-readable provider name for the UI
//     attribution,    // the data attribution string the route display owes
//     public,         // true when the endpoint is a free public instance the
//                     // shared rate limiter must protect
//     isConfigured(), // false when a required URL/key is missing
//     capabilities,   // { modes: ['driving', ...], alternatives, waypoints,
//                     //   steps, traffic, restrictions, transit }
//                     // -- only modes the engine genuinely serves. The UI
//                     // and the pipeline both read this; a mode absent here
//                     // is refused with unsupported_mode before any request.
//     route(request), // -> RouteResult[] (normalized); request is
//                     // { origin, destination, waypoints, mode } with
//                     // parsed { lat, lon } points
//   }
//
// Adapter failures throw the typed errors from routingError() below; the HTTP
// layer in server.js maps each code to its status. An adapter returns routes
// ONLY from its provider's actual response: an empty answer is the typed
// no_route error, never a fabricated fallback, and an unconfigured adapter
// throws rather than returning anything at all.
'use strict';

// Typed error codes shared by every layer. server.js maps:
//   invalid_request -> 400, unsupported_mode -> 400, no_route -> 404,
//   not_configured -> 501, rate_limited -> 429, timeout -> 504,
//   everything else -> 502 (provider_error).
function routingError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The one outbound-request helper the implemented adapters share. Every
// failure becomes a typed error with a message the client can show unchanged:
// timeout/abort, unreachable host, non-OK status (an upstream 429 is called
// out honestly — the app's own rate limit is a separate, bucket-level code),
// and an unreadable body. `fetchImpl` is injectable so tests never touch the
// network.
async function requestJson(url, { headers, timeoutMs, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw routingError('timeout', 'The routing provider did not answer in time.');
    }
    throw routingError('provider_error', 'The routing provider could not be reached.');
  }
  if (!res.ok) {
    throw routingError(
      'provider_error',
      res.status === 429
        ? 'The routing provider is throttling requests right now.'
        : `The routing provider answered with status ${res.status}.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw routingError('provider_error', 'The routing provider sent an unreadable answer.');
  }
}

const registry = new Map();

function register(provider) {
  registry.set(provider.name, provider);
}

function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) {
    throw routingError(
      'not_configured',
      `Unknown routing provider "${name}". Configure ROUTING_PROVIDER with one of: ` +
        [...registry.keys()].join(', ') + '.',
    );
  }
  return provider;
}

function providerNames() {
  return [...registry.keys()];
}

module.exports = { routingError, requestJson, register, getProvider, providerNames };
