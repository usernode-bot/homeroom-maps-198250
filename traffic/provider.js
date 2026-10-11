// The TrafficProvider contract and the provider registry (Phase 12D).
//
// This is the provider-ready adapter shell the Phase 12D spec approved: the
// CONTRACT a future authorized adapter plugs into, and an EMPTY registry. No
// traffic adapter ships in this change and none may until the T1 gate
// (traffic/provider-policy.js) opens — which requires a repository document
// naming a provider whose terms the owner has accepted.
//
// An adapter turns one traffic provider's response shape into the app's
// normalized types. Nothing above the adapter layer may read a
// provider-specific field, so switching providers is a config change, never a
// UI change — the same rule the routing stack follows. Every adapter exports:
//
//   {
//     name,           // stable identifier, matches TRAFFIC_PROVIDER values
//     label,          // human-readable provider name for the UI
//     attribution,    // the data attribution string the traffic display owes
//     public,         // true when the endpoint is a free public instance the
//                     // shared rate limiter must protect
//     isConfigured(), // false when a required URL/key is missing — ALWAYS
//                     // false until that adapter's own change declares its
//                     // secret in dapp.json per the platform convention
//     capabilities,   // { flow, incidents, speeds } — only what the provider
//                     // genuinely serves. An aspirational `true` on an
//                     // unconfigured adapter is NOT a live source (see
//                     // routing/providers/valhalla.js for the trap this
//                     // avoids): the resolver keys on isConfigured() first.
//     getFlow(bbox),      // -> TrafficFlow  (see below)
//     getIncidents(bbox), // -> TrafficIncident[] (see below)
//   }
//
// Normalized types (docs/wave-5-master-spec.md, 12D):
//   TrafficFlow      { segments: [{ geometry, speed,
//                                  congestion: 'low'|'medium'|'high' }] }
//   TrafficIncident  { id, type: 'accident'|'construction'|'closure'|…,
//                      location, description, startTime, endTime }
//   Every response additionally carries `fetchedAt` and the provider's own
//   data timestamp, because staleness must be displayable, never guessable.
//
// Adapter failures throw the typed errors from trafficError() below; the HTTP
// layer maps each code to its status exactly like routing's. An adapter
// returns traffic ONLY from its provider's actual response: an empty answer
// is the honest no-coverage state, never a fabricated "roads are clear", and
// an unconfigured adapter throws rather than returning anything at all.
//
// BOUNDARY: a community report (public/js/services/traffic.js) is NEVER live
// traffic. Nothing in this module accepts, promotes or merges user reports;
// promoting a report to a verified condition would need a verification
// process that does not exist and has not been specified.
'use strict';

// Typed error codes shared by every layer. server.js maps them like routing's:
//   not_configured -> 501, rate_limited -> 429, timeout -> 504,
//   everything else -> 502 (provider_error).
function trafficError(code, message) {
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
    throw trafficError(
      'not_configured',
      `Unknown traffic provider "${name}". No live traffic provider is connected yet` +
        (registry.size ? `; configured adapters: ${[...registry.keys()].join(', ')}.` : '.'),
    );
  }
  return provider;
}

function providerNames() {
  return [...registry.keys()];
}

// `registry` is exported for tests only: a test that registers an adapter
// must remove it again so the shipped registry stays empty.
module.exports = { trafficError, register, getProvider, providerNames, registry };
