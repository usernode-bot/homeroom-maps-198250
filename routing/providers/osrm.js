// OSRM adapter — the app's DEFAULT routing provider.
//
// OSRM (Open Source Routing Machine) is a BSD-2-licensed routing engine over
// OpenStreetMap data. The public demo server (router.project-osrm.org) is
// free, needs no key, and serves the car profile — which is why the app ships
// working Directions without any secret, the same policy the search stack
// applies with Photon. Its soft "reasonable use" expectation is honoured via
// the shared token bucket, the response cache and client-side duplicate
// guards (see routing/index.js).
//
// Profile configuration: an OSRM server serves the profiles it was built
// with, one per deployment, and the public demo is car-only. `profiles` maps
// the app's travel modes onto OSRM profile names and comes from the
// OSRM_PROFILES environment variable (see config.js); the default declares
// driving only, so walking/cycling/transit/motorcycle are REFUSED —
// unsupported_mode — rather than pretended. A self-hosted deployment serving
// a foot or bike profile enables those modes purely through configuration,
// with no code change.
//
// Provider response shape (OSRM /route service, geometries=geojson):
//   code     'Ok' | 'NoRoute' | 'NoSegment' | 'InvalidQuery' | ...
//   routes[] { geometry: { coordinates: [[lng, lat], ...] }, distance,
//              duration, legs: [{ steps: [{ geometry, maneuver, name, ref,
//              distance, duration }], distance, duration }] }
//   distances are metres, durations seconds, coordinates [lng, lat].
//
// Restrictions: the OSRM route response does not surface turn restrictions
// (they are baked into the profile at contract time), so restrictions stays
// []. That is an honest absence — the UI shows no restriction claims for it.
// TODO(provider-parity): a restriction-capable provider (e.g. Valhalla,
// GraphHopper) would fill restrictions here, and the UI already renders them.
//
// TODO(provider-parity): traffic-aware durations do not exist on OSRM; the
// durations returned are profile-based OSM estimates and are labelled as
// "estimated" by the UI, never as live traffic.
'use strict';

const { requestJson, routingError } = require('../provider');
const { normalizeRoute, roadNamesOf } = require('../normalize');

const DEFAULT_TIMEOUT_MS = 8000;

function createOsrm({
  url,
  profiles = { driving: 'driving' },
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!url) throw new Error('createOsrm needs a base URL.');
  if (!profiles || !Object.keys(profiles).length) {
    throw new Error('createOsrm needs at least one profile.');
  }

  const modes = Object.keys(profiles).filter((mode) => Boolean(profiles[mode]));

  // OSRM's own error codes -> the app's typed codes. NoRoute and NoSegment
  // both mean "no drivable path was found through the road network near
  // these points": NoSegment additionally covers a point that is not near
  // any road at all. Both are the honest "No route found" state, never a
  // fabricated fallback.
  function classifyCode(code) {
    if (code === 'NoRoute' || code === 'NoSegment') {
      return routingError(
        'no_route',
        'No route was found between these points. Try moving them closer to a road.',
      );
    }
    if (code === 'InvalidQuery' || code === 'InvalidUrl') {
      return routingError(
        'invalid_request',
        'The route request was not valid for the routing provider.',
      );
    }
    return routingError(
      'provider_error',
      `The routing provider answered with status ${code}.`,
    );
  }

  function buildUrl(request) {
    const profile = profiles[request.mode];
    const points = [request.origin, ...request.waypoints, request.destination];
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
    const qs = new URLSearchParams({
      // Up to two alternative routes when the road network offers them; OSRM
      // returns fewer or none where it cannot, and the UI shows only what
      // arrived.
      alternatives: 'true',
      steps: 'true',
      overview: 'simplified',
      geometries: 'geojson',
    });
    return `${url}/route/v1/${profile}/${coords}?${qs.toString()}`;
  }

  async function route(request) {
    const body = await requestJson(buildUrl(request), {
      headers: { Accept: 'application/json' },
      timeoutMs,
      fetchImpl,
    });
    if (!body || body.code !== 'Ok') throw classifyCode(body && body.code);
    const raw = Array.isArray(body.routes) ? body.routes : [];
    const routes = raw
      .map((r) =>
        normalizeRoute(
          {
            geometry: r && r.geometry && r.geometry.coordinates,
            distance: r && r.distance,
            duration: r && r.duration,
            legs: r && r.legs,
          },
          'osrm',
        ),
      )
      .filter(Boolean);
    if (!routes.length) {
      throw routingError('no_route', 'No route was found between these points.');
    }
    // roadInformation derives strictly from the steps the provider returned
    // (real road names in traversal order); OSRM supplies no route summary,
    // so summary stays null rather than being composed by hand.
    for (const route of routes) route.roadInformation = roadNamesOf(route.legs);
    return routes;
  }

  return {
    name: 'osrm',
    label: 'OSRM',
    attribution: 'OpenStreetMap',
    public: true, // free public endpoint -> the shared token bucket applies
    capabilities: {
      // Only the profiles the configured endpoint actually serves.
      modes,
      alternatives: true,
      waypoints: true,
      steps: true,
      traffic: false,
      restrictions: false,
      transit: false,
    },
    isConfigured() {
      return Boolean(url && modes.length);
    },
    route,
  };
}

module.exports = { createOsrm };
