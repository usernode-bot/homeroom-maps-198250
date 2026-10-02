// Assistant service — the browser half of /api/assistant.
//
// Two things live here, deliberately:
//
//   1. The thin API bindings (turn / act / status), carrying the platform
//      token through the app's own apiGet/apiSend wrappers so a typed
//      ApiError (and its error.code) reaches the sheet unchanged.
//   2. `mapContext()`, which builds the NON-AUTHORITATIVE, client-side map
//      context from what the app already holds. There is deliberately no
//      /api/assistant/context endpoint and no server-side map state: the map
//      context is client-only, and the server treats it as an unverified hint
//      that never becomes a fact (see assistant/prompt.js).
//
// The confirmed WRITE is never issued from here: the screen calls the existing
// domain services (services/saved-places.js, services/trips.js) directly after
// a confirmation, so the assistant adds no write endpoint.
import { apiGet, apiSend } from '../api.js';
import { createAssistantSession } from './assistant-core.js';
import { t } from '../i18n/index.js';
import { getLocale } from '../i18n/index.js';

export async function fetchStatus({ demo = false } = {}) {
  return apiGet('/api/assistant/status' + (demo ? '?demo=1' : ''));
}

// `messages` is the in-memory transcript [{ role, text }]; `context` is the
// client map/route context. The server bounds and validates both.
export async function sendTurn({ messages, context, demo = false } = {}) {
  const body = {
    messages: (Array.isArray(messages) ? messages : []).map((m) => ({ role: m.role, content: m.text })),
    context: context || {},
  };
  return apiSend('POST', '/api/assistant/turn' + (demo ? '?demo=1' : ''), body);
}

// Validation/normalization only. Returns the normalized call the client
// should issue; it never performs the write itself.
export async function normalizeAction(action) {
  return apiSend('POST', '/api/assistant/act', action);
}

// ── client-side map context ──────────────────────────────────────────────
//
// Built from values the app already holds: the current screen, the map's
// visible bounding box / centre / zoom when a map adapter provides them, and
// the selected place. Every field is optional and omitted when absent, never
// guessed. Coordinates come from the app's own map or the person's already
// chosen place; the assistant never triggers a location request on its own.

// `map` is anything exposing bounds()/center()/zoom() (the MapAdapter shape,
// public/js/map/adapter.js). Anything missing or malformed is simply left out.
export function mapContext({ route, map, selectedPlace } = {}) {
  const context = {};
  if (typeof route === 'string' && route) context.route = route;
  if (map && typeof map === 'object') {
    const bounds = safeCall(map.bounds);
    if (bounds && Number.isFinite(Number(bounds.west)) && Number.isFinite(Number(bounds.south)) &&
        Number.isFinite(Number(bounds.east)) && Number.isFinite(Number(bounds.north))) {
      context.map = {
        bbox: [Number(bounds.west), Number(bounds.south), Number(bounds.east), Number(bounds.north)],
      };
    }
    const center = safeCall(map.center);
    if (center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lng))) {
      context.map = context.map || {};
      context.map.center = { lat: Number(center.lat), lng: Number(center.lng) };
    }
    const zoom = safeCall(map.zoom);
    if (Number.isFinite(Number(zoom))) {
      context.map = context.map || {};
      context.map.zoom = Number(zoom);
    }
  }
  if (selectedPlace && typeof selectedPlace === 'object' && selectedPlace.name) {
    context.selectedPlace = { name: String(selectedPlace.name).slice(0, 200) };
    if (selectedPlace.id) context.selectedPlace.id = String(selectedPlace.id).slice(0, 200);
  }
  return context;
}

function safeCall(fn) {
  if (typeof fn !== 'function') return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

// The session bound to the real API and the active locale. `overrides` lets a
// test inject a stub sendTurn.
export function createAssistant({ contextProvider, onNavigate, confirm, demo = false, ...overrides } = {}) {
  return createAssistantSession({
    sendTurn: ({ messages }) =>
      sendTurn({
        messages,
        context: typeof contextProvider === 'function' ? contextProvider() || {} : {},
        demo,
      }),
    copy: (key, params) => t(key, params),
    onNavigate,
    confirm,
    locale: getLocale(),
    ...overrides,
  });
}
