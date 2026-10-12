// The WeatherProvider contract and the provider registry (Phase 12G).
//
// Built as the sibling of search/provider.js and the same deliberate shape:
// an adapter turns one weather API's response into the app's normalized
// WeatherCurrent. Nothing above the adapter layer may read a provider-
// specific field, so switching providers is a config change
// (`WEATHER_PROVIDER`), never a UI change. Every adapter exports:
//
//   {
//     name,           // stable identifier, matches WEATHER_PROVIDER values
//     isConfigured(), // false when a required URL/key is missing
//     current({ lat, lng, lang }),  // -> raw provider payload for one point
//   }
//
// The registry ships EMPTY. No weather provider is implemented or
// authorized yet (the W1 gate in weather/provider-policy.js keeps it that
// way until docs/weather-provider-rights.md says otherwise), so getProvider
// throws not_configured for every name — which is exactly what makes the
// app answer an honest 501 instead of fabricated weather.
//
// Adapter failures throw the typed errors from weatherError() below; the
// HTTP layer in server.js maps each code to its status. An adapter returns
// data ONLY from its provider's actual response: a partial answer is an
// error, never a filled-in guess, and an unconfigured adapter throws rather
// than returning anything at all.
'use strict';

// Typed error codes shared by every layer. server.js maps:
//   invalid_request -> 400, not_configured -> 501, rate_limited -> 429,
//   timeout -> 504, everything else -> 502 (provider_error).
function weatherError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The one outbound-request helper the eventual adapters share. Every failure
// becomes a typed error with a message the client can show unchanged:
// timeout/abort (mapped to the dedicated `timeout` code — weather is
// time-sensitive, so "no answer in time" is its own state), unreachable
// host, non-OK status (upstream 429 is called out honestly — the app's own
// rate limit is a separate, bucket-level code), and an unreadable body.
// `fetchImpl` is injectable so tests never touch the network.
async function requestJson(url, { headers, timeoutMs, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw weatherError('timeout', 'The weather provider did not answer in time.');
    }
    throw weatherError('provider_error', 'The weather provider could not be reached.');
  }
  if (!res.ok) {
    throw weatherError(
      'provider_error',
      res.status === 429
        ? 'The weather provider is throttling requests right now.'
        : `The weather provider answered with status ${res.status}.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw weatherError('provider_error', 'The weather provider sent an unreadable answer.');
  }
}

const registry = new Map();

function register(provider) {
  registry.set(provider.name, provider);
}

function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) {
    throw weatherError(
      'not_configured',
      `Unknown weather provider "${name}". No weather adapter is implemented yet; ` +
        'configure WEATHER_PROVIDER only after the W1 authorization gate is satisfied.',
    );
  }
  return provider;
}

function providerNames() {
  return [...registry.keys()];
}

module.exports = { weatherError, requestJson, register, getProvider, providerNames };
