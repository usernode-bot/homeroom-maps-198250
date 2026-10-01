// Routing service — the client-side RoutingService's browser-facing half.
//
// The Directions screen talks to this and never to a routing provider
// directly; this module binds the pure session core (routing-core.js) to the
// real fetcher: GET /api/directions on this app's own server, which applies
// the auth gate, provider selection and the server-side provider adapters.
// The provider (OSRM today, another engine tomorrow) is a server config
// change and never a client or UI change — the same rule the search stack
// follows.
//
// `fetchDirections` and `capabilitiesFromConfig` are kept exported so a later
// phase (navigation) can call them without the screen session.
import { apiGet } from '../api.js';
import {
  TRAVEL_MODES,
  createDirectionsSession as createSessionCore,
} from './routing-core.js';

export { TRAVEL_MODES };

// The routing block of /api/config, normalized for the client. When the
// server reports no configured provider the modes list is empty, so the UI
// renders the honest not-configured state instead of a form that could never
// route.
export function capabilitiesFromConfig(config) {
  const routing = (config && config.routing) || null;
  if (!routing || !routing.configured) return null;
  return {
    provider: routing.provider || null,
    label: routing.label || null,
    modes: Array.isArray(routing.modes) ? routing.modes : [],
    alternatives: Boolean(routing.capabilities && routing.capabilities.alternatives),
    waypoints: Boolean(routing.capabilities && routing.capabilities.waypoints),
    // Surfaced for navigation (Phase 8): whether the provider supplies turn
    // steps, and whether durations are traffic-aware. `steps` false means the
    // maneuver banner honestly reads "Instructions unavailable"; `traffic`
    // false means durations are never labelled as live.
    steps: Boolean(routing.capabilities && routing.capabilities.steps),
    traffic: Boolean(routing.capabilities && routing.capabilities.traffic),
    attribution: routing.attribution || 'OpenStreetMap',
  };
}

// Low-level fetch. `request` is the normalized request shape
// ({ origin, destination, waypoints, mode } with { lat, lon } points); it
// resolves with the server's routes array or throws the typed ApiError (the
// server's error codes ride through on it).
export async function fetchDirections(request, { signal } = {}) {
  const points = (p) => `${p.lat},${p.lon}`;
  const qs = new URLSearchParams();
  qs.set('origin', points(request.origin));
  qs.set('destination', points(request.destination));
  if (request.waypoints && request.waypoints.length) {
    qs.set('waypoints', request.waypoints.map(points).join('|'));
  }
  if (request.mode) qs.set('mode', request.mode);
  const body = await apiGet(`/api/directions?${qs.toString()}`, { signal });
  return Array.isArray(body && body.routes) ? body.routes : [];
}

// The Directions session bound to the real fetcher and the app's public
// config. `overrides` lets tests inject fetchers/config without the core
// leaking browser globals.
export function createDirectionsSession({ config, ...overrides } = {}) {
  const capabilities = capabilitiesFromConfig(config);
  return createSessionCore({
    fetchRoute: fetchDirections,
    capabilities: capabilities || { modes: [], alternatives: false, waypoints: false },
    ...overrides,
  });
}
