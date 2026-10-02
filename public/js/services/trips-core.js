// Trips core — the pure, testable helpers behind the Trips screen.
//
// Nothing here touches the DOM, the network or the app's singleton state, so
// node:test drives it directly (tests/trips.model.test.js). The screen binds
// the real fetchers; this module owns the arithmetic and formatting that is
// easy to get subtly wrong: day-range expansion, reorder math, which travel
// modes a provider genuinely serves, which consecutive stops form a leg, and
// how a leg line is worded. It never invents a value: a missing distance,
// duration or geometry stays missing.
'use strict';

import { formatDate, formatDistance, formatDuration, formatWeekday } from '../i18n/format.js';
import { ROUTE_ERROR_COPY, TRAVEL_MODES } from './routing-core.js';

export { ROUTE_ERROR_COPY };

// ── dates ────────────────────────────────────────────────────────────────

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

// Inclusive [start, end] -> one ISO date per day, oldest first. Pure and
// leap-year correct; an inverted or malformed range yields [].
export function dayRange(startDate, endDate) {
  const from = parseIsoDate(startDate);
  const to = parseIsoDate(endDate);
  if (!from || !to) return [];
  const span = Math.round(
    (Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86400000,
  );
  if (span < 0) return [];
  const out = [];
  for (let i = 0; i <= span; i += 1) {
    out.push(new Date(Date.UTC(from.y, from.m - 1, from.d + i)).toISOString().slice(0, 10));
  }
  return out;
}

// A day heading: "Saturday, 13 Jun 2026" (weekday + medium date), in the
// active locale. Built entirely from Intl; an unusable date yields ''.
export function dayLabel(isoDate, { locale, timeZone } = {}) {
  const date = parseIsoDate(isoDate);
  if (!date) return '';
  const value = new Date(Date.UTC(date.y, date.m - 1, date.d));
  const weekday = formatWeekday(value, { locale, timeZone });
  const full = formatDate(value, { locale, timeZone });
  return weekday ? weekday + ', ' + full : full;
}

// ── reorder math ─────────────────────────────────────────────────────────

// Move within one list. Returns a NEW array; an out-of-range source leaves
// the list unchanged. Works on items or on plain ids.
export function moveWithin(items, from, to) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);
  return list;
}

// Move an entry from one list into another at `to`, clamping the target into
// range. Returns { fromList, toList } as new arrays.
export function moveBetween(fromItems, toItems, from, to) {
  const source = Array.isArray(fromItems) ? fromItems.slice() : [];
  const dest = Array.isArray(toItems) ? toItems.slice() : [];
  if (from < 0 || from >= source.length) return { fromList: source, toList: dest };
  const clamped = Math.max(0, Math.min(dest.length, to));
  const [moved] = source.splice(from, 1);
  dest.splice(clamped, 0, moved);
  return { fromList: source, toList: dest };
}

// ── travel modes ─────────────────────────────────────────────────────────

// The modes the active routing provider genuinely serves, from the routing
// block of /api/config — exactly what Directions offers. Never assumed.
export function selectableModes(config) {
  const routing = (config && config.routing) || null;
  if (!routing || !routing.configured || !Array.isArray(routing.modes)) return [];
  return routing.modes.filter((m) => TRAVEL_MODES[m]);
}

// The modes the app models but this provider does not serve, so the selector
// can show them honestly as unavailable.
export function unavailableModes(config) {
  const served = new Set(selectableModes(config));
  return Object.keys(TRAVEL_MODES).filter((m) => !served.has(m));
}

// ── legs ─────────────────────────────────────────────────────────────────

function coordinatesOf(item) {
  const c = item && item.place && item.place.coordinates;
  if (!c) return null;
  const lat = Number(c.lat);
  const lng = Number(c.lng != null ? c.lng : c.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// Consecutive stop pairs where BOTH stops carry coordinates — the only pairs
// a provider could ever route. A stop with no coordinates breaks the chain;
// nothing is interpolated.
export function legPairs(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 1; i < list.length; i += 1) {
    const origin = coordinatesOf(list[i - 1]);
    const destination = coordinatesOf(list[i]);
    if (!origin || !destination) continue;
    out.push({
      from: list[i - 1],
      to: list[i],
      origin,
      destination,
      key: (list[i - 1].id != null ? list[i - 1].id : i - 1) + '|' + (list[i].id != null ? list[i].id : i),
    });
  }
  return out;
}

// The normalized routing request for one leg (services/routing.js shape).
export function legRequest(pair, mode) {
  return {
    origin: { lat: pair.origin.lat, lon: pair.origin.lng },
    destination: { lat: pair.destination.lat, lon: pair.destination.lng },
    ...(mode ? { mode } : {}),
  };
}

// Map a routing/API error code onto the app's existing route error kinds, so
// the screen can word it with ROUTE_ERROR_COPY. Unknown codes degrade to
// 'provider', an honest failure rather than a fabricated success.
export function legErrorKind(err) {
  const code = err && err.code;
  switch (code) {
    case 'no_route':
    case 'unsupported_mode':
    case 'rate_limited':
    case 'timeout':
    case 'invalid_request':
      return code;
    case 'network_error':
      return 'network';
    default:
      return 'provider';
  }
}

// One leg line, unit- and locale-aware through i18n/format.js. A null half
// reads the injected (localized) unavailable label; the screen passes the
// trips.* copy. Distances/durations are never synthesized.
export function legLine(distance, duration, { locale, units, labels } = {}) {
  const copy = labels || {
    distance: 'Distance unavailable',
    duration: 'Duration unavailable',
  };
  // A null/absent half is the unavailable label; a real 0 still formats as
  // "0 m" / "0 min", so absence and zero are never confused.
  const d = distance == null ? '' : formatDistance(distance, { locale, units });
  const time = duration == null ? '' : formatDuration(duration, { locale });
  return (d || copy.distance) + ' · ' + (time || copy.duration);
}

// The { name, lat?, lng? } body the trip API stores for a destination the
// user picked from search, or null when none is chosen. Coordinates are the
// selected result's own; typed text is never geocoded into a destination.
export function destinationBody(current) {
  if (!current || !current.name) return null;
  const out = { name: current.name };
  if (current.coordinates) {
    out.lat = current.coordinates.lat;
    out.lng = current.coordinates.lon;
  }
  return out;
}
