// Routing service — the server-side RoutingService.
//
// One entry point, run(params), that the HTTP route calls. The pipeline per
// call is, in order:
//
//   validate -> resolve adapter -> capability check -> rate limit -> cache
//            -> provider adapter -> normalize -> { provider, mode, routes }
//
// Typed errors (routing/provider.js) propagate to server.js, which maps each
// code to its HTTP status; the client's typed ApiError handling picks the
// messages up unchanged. This module owns no provider-specific knowledge.
//
// The capability check here is the second copy of the rule the UI already
// applies (the UI renders only modes the config advertises): a mode the
// active provider does not serve is refused with unsupported_mode before any
// request is made, in either layer, so an unsupported mode can never reach a
// real engine.
'use strict';

const { ROUTING_PROVIDER, OSRM_URL, OSRM_PROFILES } = require('../config');
const { register, getProvider, routingError } = require('./provider');
const { validateRouteRequest, MODE_LABELS } = require('./normalize');
const { TokenBucket } = require('../search/rate-limit');
const { SearchCache } = require('../search/cache');
const { createOsrm } = require('./providers/osrm');
const { createValhalla } = require('./providers/valhalla');
const { createGraphhopper } = require('./providers/graphhopper');

// One shared bucket for every PUBLIC provider endpoint: aggregate politeness
// toward the free public routing server, mirroring the search stack's
// posture toward the free geocoders.
const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });

// Route cache: a route between fixed points on a traffic-free engine changes
// slowly (map data updates), so a short TTL covers double taps and repeat
// visits without serving anything meaningfully stale. Per-process; restarts
// simply empty it.
const cache = new SearchCache({ maxEntries: 300 });
const ROUTE_TTL_MS = 10 * 60 * 1000;

// Build every adapter once and register it, so getProvider() resolves by
// name. Adapters are pure configuration; none of them contacts its endpoint
// at construction time.
const providers = {
  osrm: createOsrm({ url: OSRM_URL, profiles: OSRM_PROFILES }),
  valhalla: createValhalla(),
  graphhopper: createGraphhopper(),
};
for (const provider of Object.values(providers)) {
  register(provider);
}

// The public routing block for GET /api/config. Non-sensitive by contract:
// the provider's name, which travel modes the configured endpoint actually
// serves (the UI's travel-mode selector is driven by exactly this), the
// capabilities that shape the UI, and the data attribution the route display
// owes. Nothing here reads a key or a secret.
function resolveRoutingConfig() {
  try {
    const provider = getProvider(ROUTING_PROVIDER);
    if (!provider.isConfigured()) throw routingError('not_configured', 'not configured');
    return {
      configured: true,
      provider: provider.name,
      label: provider.label,
      modes: [...provider.capabilities.modes],
      capabilities: {
        alternatives: provider.capabilities.alternatives,
        waypoints: provider.capabilities.waypoints,
        steps: provider.capabilities.steps,
        traffic: provider.capabilities.traffic,
        restrictions: provider.capabilities.restrictions,
        transit: provider.capabilities.transit,
      },
      attribution: provider.attribution,
    };
  } catch {
    // An unknown or unconfigured provider is the explicit not-configured
    // state: the Directions UI renders honest placeholders rather than
    // pretending a routing backend exists.
    return {
      configured: false,
      provider: null,
      label: null,
      modes: [],
      capabilities: {
        alternatives: false,
        waypoints: false,
        steps: false,
        traffic: false,
        restrictions: false,
        transit: false,
      },
      attribution: 'OpenStreetMap',
    };
  }
}

// The single pipeline. `params` are the RAW HTTP query values. `opts` exists
// for tests only: `providerName` overrides the configured provider so a stub
// can exercise the pipeline without touching the network.
async function run(params, opts = {}) {
  const request = validateRouteRequest(params);

  const provider = getProvider(opts.providerName || ROUTING_PROVIDER);
  if (!provider.isConfigured()) {
    throw routingError(
      'not_configured',
      `The ${provider.name} routing provider is not configured yet.`,
    );
  }
  if (!provider.capabilities.modes.includes(request.mode)) {
    throw routingError(
      'unsupported_mode',
      `${MODE_LABELS[request.mode] || request.mode} routing is not supported by the configured ${provider.name} provider.`,
    );
  }

  // Politeness first, per the pipeline order: a full cache would still cost
  // the public endpoint nothing, but the bucket protects burst patterns too.
  if (provider.public && !bucket.tryTake()) {
    throw routingError('rate_limited', 'Routing is busy right now. Try again in a moment.');
  }

  const cacheKey = [
    provider.name,
    request.mode,
    request.origin.lat,
    request.origin.lon,
    request.destination.lat,
    request.destination.lon,
    ...request.waypoints.map((w) => `${w.lat},${w.lon}`),
  ].join('|');
  const cached = cache.get(cacheKey);
  if (cached) {
    return { provider: provider.name, mode: request.mode, routes: cached, cached: true };
  }

  const routes = await provider.route(request);
  cache.set(cacheKey, routes, ROUTE_TTL_MS);
  return { provider: provider.name, mode: request.mode, routes, cached: false };
}

module.exports = { run, resolveRoutingConfig };
