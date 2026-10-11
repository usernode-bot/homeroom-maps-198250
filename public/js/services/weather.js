// Weather browser service (Phase 12G) — the thin wrapper that gives the pure
// session (weather-core.js) the real network, the real clock and the real
// online/offline events. The same split as directions.js over
// directions-session.js: one module-level session, an AbortController per
// in-flight request, and aborts that never settle as errors.
//
// The wrapper's one hard rule on top of the core's: a superseded request
// (a newer one started, the panel refocused elsewhere) returns a
// never-settling promise, so a stale answer can never land in the panel.
'use strict';

import { apiGet, fetchConfig } from '../api.js';
import { createWeatherSession } from './weather-core.js';

let controller = null;

const session = createWeatherSession({
  isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true),
  fetchCurrent: async (center) => {
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    try {
      return await apiGet(`/api/weather/current?lat=${center.lat}&lng=${center.lng}`, { signal });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        // Superseded by a newer request. Never settle: the panel must not
        // see this as an error or as an answer.
        return new Promise(() => {});
      }
      throw err;
    }
  },
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => session.setOnline(true));
  window.addEventListener('offline', () => session.setOnline(false));
}

// Feed the session the weather capability block from /api/config. The home
// screen calls this once per config load, before anything can open the panel.
export function setWeatherCapability(config) {
  session.setCapability(config);
}

export function weatherState() {
  return session.getState();
}

export function subscribeWeather(fn) {
  return session.subscribe(fn);
}

// Ask for current conditions at a { lat, lng } centre. The session decides
// whether a request may happen at all: with no authorized provider this
// fetches nothing and the state stays 'unavailable'.
export function requestWeather(center) {
  return session.request(center);
}

export function refreshWeather() {
  return session.refresh();
}

// The map centre moved while the panel cares; the session throttles and
// auto-refetches past a 1 km move.
export function notifyWeatherCenter(center) {
  return session.movedTo(center);
}

// Re-read /api/config and re-apply the capability. The "Check again" control
// in the unavailable state calls this: it is a request to the app's own
// config endpoint, never to a weather host.
export async function recheckWeather() {
  try {
    const config = await fetchConfig();
    session.setCapability(config && config.weather);
  } catch {
    // The config endpoint being unreachable does not make weather available
    // or unavailable; keep the current honest state.
  }
  return session.getState();
}
