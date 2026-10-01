// Directions service — superseded by the Phase 4 routing stack.
//
// The old interface-only stub (`route(from, to, mode)`) is gone. The real
// Directions implementation lives in:
//
//   services/routing.js      — the RoutingService the UI talks to (fetch +
//                              capabilities from /api/config),
//   services/routing-core.js — the pure session state machine (validation,
//                              swap, waypoints, mode capability, stale
//                              responses, formatting).
//
// This re-export keeps any stray import of `./services/directions.js`
// working and pointing at the real thing.
export {
  fetchDirections,
  capabilitiesFromConfig,
  createDirectionsSession,
} from './routing.js';
