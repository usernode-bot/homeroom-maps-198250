// Weather session core (Phase 12G) — the pure state machine behind the
// weather panel, the sibling of directions-session.js: no DOM, no fetch, no
// timers. The browser wrapper (weather.js) supplies the network and the
// online/offline events; node:test drives this module directly.
//
// The honesty rules this module enforces, no matter what a caller does:
//
//   - With no authorized provider (capability.configured false), NOTHING is
//     ever fetched and no data state is ever reachable. The session sits in
//     'unavailable' and says so.
//   - A reading is shown only in 'ready' or 'stale', never during loading,
//     and 'stale' is its own state — an old reading is never re-served as
//     current.
//   - A superseded request (a newer one started, or the centre moved) can
//     never settle: its generation number no longer matches.
//   - A payload missing its provider, attribution or observed time is
//     rejected outright rather than rendered with holes.
//   - An offline device produces the 'offline' state without a request, and
//     reconnect routes through a fresh fetch, never a silent replay.
'use strict';

// A reading older than this is its own stale state, never presented as
// current. One hour, per the spec.
export const WEATHER_STALE_AFTER_MS = 60 * 60 * 1000;
// Client-side refresh throttle: at most one fetch a minute while a reading
// is already on screen (the server cache is 10 minutes; this keeps a
// tap-happy panel from hammering it anyway).
export const WEATHER_CLIENT_MIN_REFRESH_MS = 60 * 1000;
// Auto-refetch threshold when the map centre moves while the panel is open.
export const WEATHER_AUTO_REFETCH_DISTANCE_M = 1000;
// The condition fields the panel knows how to render. Everything else in a
// payload is ignored rather than guessed at.
export const WEATHER_FIELD_KEYS = ['temperature', 'precipitation', 'wind'];

// Pure: what the capability block from /api/config means for the panel.
// Anything unreadable resolves to the honest unavailable state naming the
// W1 gate, the same way a missing block would.
export function resolveWeatherCapability(config) {
  const block = config && typeof config === 'object' ? config : null;
  if (!block || block.configured !== true) {
    return {
      available: false,
      blocker: (block && block.blocker) || 'W1',
      reason: (block && typeof block.reason === 'string' && block.reason) || null,
    };
  }
  return { available: true, blocker: null, reason: null };
}

// Pure: round a centre to the 3-decimal grid the server's cache uses, or
// null when the value cannot honestly name a point on the map.
export function roundCenter(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: Number(a.toFixed(3)), lng: Number(b.toFixed(3)) };
}

// Pure: great-circle distance in metres, or null for unusable input. The
// same haversine shape traffic.js uses.
export function distanceMeters(a, b) {
  if (!a || !b) return null;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng) - toRad(a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(s)));
}

// Pure: is a reading's observation time older than the stale window? An
// unreadable time is stale — the panel never presents what it cannot date.
export function isStale(observedAt, nowMs = Date.now(), staleAfterMs = WEATHER_STALE_AFTER_MS) {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > staleAfterMs;
}

// Pure unit formatters. `units` is 'metric' or 'imperial' (resolveUnits'
// output); every formatter returns null for an unusable value rather than
// inventing one. null and undefined are unusable (Number(null) is 0, which
// would otherwise render an absent reading as a real zero).
export function formatTemperature(celsius, units = 'metric') {
  if (celsius == null) return null;
  const c = Number(celsius);
  if (!Number.isFinite(c)) return null;
  return units === 'imperial' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

export function formatWind(metersPerSecond, units = 'metric') {
  if (metersPerSecond == null) return null;
  const v = Number(metersPerSecond);
  if (!Number.isFinite(v) || v < 0) return null;
  return units === 'imperial'
    ? `${Math.round(v * 2.2369363)} mph`
    : `${Math.round(v * 3.6)} km/h`;
}

export function formatPrecipitation(mmPerHour, units = 'metric') {
  if (mmPerHour == null) return null;
  const v = Number(mmPerHour);
  if (!Number.isFinite(v) || v < 0) return null;
  if (units === 'imperial') {
    const inches = Math.round((v / 25.4) * 100) / 100;
    return `${inches} in/h`;
  }
  const mm = Math.round(v * 100) / 100;
  return `${mm} mm/h`;
}

// Pure: which state does a failed fetch map to? Network-shaped failures are
// the offline state (the device cannot reach the app's own API); everything
// else is the generic error state. Abort errors are handled by the caller
// (a superseded request never settles), so they never reach this.
export function classifyWeatherError(err) {
  const code = err && err.code;
  if (code === 'network_error' || code === 'ABORT_ERR' || (err && err.name === 'AbortError')) {
    return 'offline';
  }
  return 'error';
}

// Pure: check the completeness of a payload the server returned. The panel
// renders only what this accepts — a response missing its provider,
// attribution or observed time is an error, never a reading with holes.
export function normalizeWeatherReading(reading) {
  if (!reading || typeof reading !== 'object') return { ok: false, reason: 'incomplete' };
  const provider = typeof reading.provider === 'string' && reading.provider.trim() ? reading.provider.trim() : null;
  const attribution =
    typeof reading.attribution === 'string' && reading.attribution.trim() ? reading.attribution.trim() : null;
  const observedAt = typeof reading.observedAt === 'string' && Number.isFinite(Date.parse(reading.observedAt))
    ? reading.observedAt
    : null;
  if (!provider || !attribution || !observedAt) return { ok: false, reason: 'incomplete' };
  const out = { provider, attribution, observedAt };
  if (reading.observedAtEstimated === true) out.observedAtEstimated = true;
  // A field value counts only when the payload carries an actual value:
  // null, undefined and empty strings are absent, a real 0 is a reading.
  const supplied = (key) =>
    reading[key] != null && reading[key] !== '' && Number.isFinite(Number(reading[key]));
  const fields = Array.isArray(reading.fields)
    ? reading.fields.filter((f) => WEATHER_FIELD_KEYS.includes(f))
    : [];
  if (fields.includes('temperature') && supplied('temperatureC')) {
    out.temperatureC = Number(reading.temperatureC);
  }
  if (fields.includes('precipitation') && supplied('precipitationMmH')) {
    out.precipitationMmH = Number(reading.precipitationMmH);
  }
  if (fields.includes('wind') && supplied('windSpeedMs')) {
    out.windSpeedMs = Number(reading.windSpeedMs);
    if (supplied('windDirectionDeg')) {
      out.windDirectionDeg = Number(reading.windDirectionDeg);
    }
  }
  out.fields = fields.filter((f) => {
    if (f === 'temperature') return out.temperatureC != null;
    if (f === 'precipitation') return out.precipitationMmH != null;
    if (f === 'wind') return out.windSpeedMs != null;
    return false;
  });
  if (!out.fields.length) return { ok: false, reason: 'incomplete' };
  if (typeof reading.condition === 'string' && reading.condition.trim()) {
    out.condition = reading.condition.trim();
  }
  return { ok: true, reading: out };
}

// The session. `fetchCurrent(center, meta)` is injected by the browser
// wrapper; `now` and `isOnline` are injectable so tests drive the clock and
// the connection state deterministically.
export function createWeatherSession({
  now = () => Date.now(),
  isOnline = () => true,
  fetchCurrent = null,
  staleAfterMs = WEATHER_STALE_AFTER_MS,
  minRefreshMs = WEATHER_CLIENT_MIN_REFRESH_MS,
  classifyError = classifyWeatherError,
} = {}) {
  let capability = resolveWeatherCapability(null);
  // state: { name, reading, error } — reading only ever set in ready/stale.
  let state = { name: 'unavailable', reading: null, error: null };
  let generation = 0;
  let lastFetchAt = null;
  let center = null;
  const listeners = new Set();

  const snapshot = () => ({ ...state, capability, center });
  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn(snapshot());
      } catch {
        // A listener failing must never break the session.
      }
    }
  }

  function canFetch() {
    return Boolean(capability.available && fetchCurrent);
  }

  function setUnavailable() {
    generation += 1; // orphan any in-flight request
    state = { name: 'unavailable', reading: null, error: null };
  }

  function setCapability(config) {
    capability = resolveWeatherCapability(config);
    if (capability.available) {
      // A previously unavailable session that just became usable picks its
      // work back up only where it has a centre to ask about.
      if (center) {
        request(center);
      }
    } else {
      setUnavailable();
    }
    emit();
  }

  async function request(nextCenter) {
    if (!canFetch()) {
      // The unavailable state is the answer; nothing is fetched, ever.
      if (state.name !== 'unavailable') setUnavailable();
      emit();
      return snapshot();
    }
    const c = nextCenter ? roundCenter(nextCenter.lat, nextCenter.lng) : null;
    if (!c) {
      // No honest coordinates: nothing is fetched and nothing is shown.
      generation += 1;
      state = { name: 'error', reading: null, error: 'no_center' };
      emit();
      return snapshot();
    }
    center = c;
    if (!isOnline()) {
      // An offline device gets the offline state without a request.
      generation += 1;
      state = { name: 'offline', reading: null, error: null };
      emit();
      return snapshot();
    }
    // Throttle only refreshes: when a reading is already on screen, back to
    // back calls within the window are no-ops.
    if (
      (state.name === 'ready' || state.name === 'stale') &&
      lastFetchAt != null &&
      now() - lastFetchAt < minRefreshMs
    ) {
      return snapshot();
    }
    generation += 1;
    const gen = generation;
    lastFetchAt = now();
    state = { name: 'loading', reading: null, error: null };
    emit();
    try {
      const raw = await fetchCurrent(c, { generation: gen });
      applyResult(gen, c, raw);
    } catch (err) {
      applyError(gen, c, err);
    }
    return snapshot();
  }

  // Does a settled fetch still describe the current request? A superseded
  // generation or a centre that has moved on is dropped, whatever it holds.
  function applies(gen, c) {
    return (
      gen === generation &&
      c &&
      center &&
      c.lat === center.lat &&
      c.lng === center.lng &&
      state.name === 'loading'
    );
  }

  function applyResult(gen, c, raw) {
    if (!applies(gen, c)) return;
    const check = normalizeWeatherReading(raw);
    if (!check.ok) {
      state = { name: 'error', reading: null, error: check.reason };
    } else {
      const stale = isStale(check.reading.observedAt, now(), staleAfterMs);
      state = { name: stale ? 'stale' : 'ready', reading: check.reading, error: null };
    }
    emit();
  }

  function applyError(gen, c, err) {
    if (!applies(gen, c)) return;
    const kind = classifyError(err);
    state = { name: kind === 'offline' ? 'offline' : 'error', reading: null, error: kind };
    emit();
  }

  function setOnline(online) {
    if (online && state.name === 'offline') {
      // Reconnect never re-serves the old reading: route through a fresh
      // fetch (the offline state holds no reading, so nothing stale can
      // slip through).
      request(center);
    }
  }

  // The map centre moved while the session cares. Only reachable states
  // refetch; the unavailable state keeps refusing.
  function movedTo(nextCenter) {
    if (!canFetch()) return snapshot();
    const c = roundCenter(nextCenter && nextCenter.lat, nextCenter && nextCenter.lng);
    if (!c) return snapshot();
    if (!center || distanceMeters(center, c) > WEATHER_AUTO_REFETCH_DISTANCE_M) {
      if (state.name !== 'unavailable') request(c);
    }
    return snapshot();
  }

  return {
    getState: snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setCapability,
    request,
    refresh: () => request(center),
    setOnline,
    movedTo,
  };
}
