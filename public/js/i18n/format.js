// Locale-aware formatting — thin wrappers over the browser's built-in Intl
// APIs. No polyfills, no locale data downloads: every supported browser and
// Node 13+ ship full ICU.
//
// The unit preference is module state, set once at boot (and on change) by
// i18n/index.js from the stored preference plus the device region. The pure
// pieces (resolveUnits, and every formatter when given explicit options) are
// unit-testable without touching that state.
'use strict';

// Regions that conventionally use imperial units first. Deliberately small
// and documented; a future locale entry extends it rather than adding UI
// conditionals.
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

// One mile in metres (exact), and the imperial short-unit cutoff: the spec's
// "metres below 1 km / feet below ⅓ mile". A third of a mile is 1760 feet.
const METRES_PER_MILE = 1609.344;
const IMPERIAL_SHORT_CUTOFF_M = METRES_PER_MILE / 3;

// Pure: which unit system a preference + device region resolve to.
// 'system' means "follow the device region"; anything unsupported also
// resolves through that path, so a stale stored value can never break
// formatting.
export function resolveUnits(pref, region) {
  if (pref === 'metric') return 'metric';
  if (pref === 'imperial') return 'imperial';
  const code = typeof region === 'string' ? region.split('-').pop().toUpperCase() : '';
  return IMPERIAL_REGIONS.has(code) ? 'imperial' : 'metric';
}

let unitPref = 'system';
let deviceRegion = null;

// Called at boot and on change by i18n/index.js. Unusable values resolve as
// 'system' (see resolveUnits), never an error.
export function setUnitsPreference(pref, region) {
  unitPref = pref === 'metric' || pref === 'imperial' ? pref : 'system';
  deviceRegion = typeof region === 'string' ? region : null;
}

export function getUnitsPreference() {
  return unitPref;
}

// The system the active preference resolves to right now.
export function activeUnits() {
  return resolveUnits(unitPref, deviceRegion);
}

function nf(locale, options) {
  try {
    return new Intl.NumberFormat(locale || 'en', options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

export function formatNumber(value, { locale, options } = {}) {
  if (!Number.isFinite(Number(value))) return '';
  return nf(locale, options || {}).format(Number(value));
}

export function formatPercent(fraction, { locale, maximumFractionDigits = 0 } = {}) {
  if (!Number.isFinite(Number(fraction))) return '';
  return nf(locale, {
    style: 'percent',
    maximumFractionDigits,
  }).format(Number(fraction));
}

// Distances: metres/feet for short lengths, kilometres/miles above, always
// through the locale's decimal and grouping separators. Thresholds:
//   metric   — metres below 1 km, kilometres above
//   imperial — feet below ⅓ mile, miles above
export function formatDistance(meters, { locale, units } = {}) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m < 0) return '';
  const system = units === 'metric' || units === 'imperial' ? units : activeUnits();
  if (system === 'imperial') {
    if (m < IMPERIAL_SHORT_CUTOFF_M) {
      const feet = Math.round(m * 3.28084);
      return nf(locale, { style: 'unit', unit: 'foot', maximumFractionDigits: 0 }).format(feet);
    }
    const miles = m / METRES_PER_MILE;
    return nf(locale, {
      style: 'unit',
      unit: 'mile',
      maximumFractionDigits: miles < 10 ? 1 : 0,
    }).format(miles);
  }
  if (m < 1000) {
    return nf(locale, { style: 'unit', unit: 'meter', maximumFractionDigits: 0 }).format(Math.round(m));
  }
  const km = m / 1000;
  return nf(locale, {
    style: 'unit',
    unit: 'kilometer',
    maximumFractionDigits: km < 10 ? 1 : 0,
  }).format(km);
}

// Durations: whole minutes below an hour, then hours and minutes. Used by
// later phases (saved trips, directions); the rule is defined now so every
// future caller formats the same way.
export function formatDuration(seconds, { locale } = {}) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '';
  const minutes = Math.round(s / 60);
  if (minutes < 60) {
    return nf(locale, { style: 'unit', unit: 'minute', maximumFractionDigits: 0 }).format(minutes);
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const fmt = nf(locale, { style: 'unit', unit: 'hour', maximumFractionDigits: 0 });
  if (!rest) return fmt.format(hours);
  return (
    fmt.format(hours) +
    ' ' +
    nf(locale, { style: 'unit', unit: 'minute', maximumFractionDigits: 0 }).format(rest)
  );
}

function dtf(locale, options) {
  try {
    return new Intl.DateTimeFormat(locale || 'en', options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

// Dates and times. `timeZone` is an IANA name (the device timezone is passed
// by the caller); an unavailable name falls back to UTC rather than throwing,
// so a date is always rendered. No localized display string is ever stored —
// these format canonical Date values for display only.
export function formatDate(date, { locale, timeZone, dateStyle = 'medium' } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return withTimeZone(dtf(locale, { dateStyle }), d, timeZone, { dateStyle }, locale);
}

export function formatTime(date, { locale, timeZone, timeStyle = 'short' } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return withTimeZone(dtf(locale, { timeStyle }), d, timeZone, { timeStyle }, locale);
}

function withTimeZone(formatter, date, timeZone, options, locale) {
  if (!timeZone) return formatter.format(date);
  try {
    return new Intl.DateTimeFormat(locale || 'en', { ...options, timeZone }).format(date);
  } catch {
    // Unavailable timezone: render in UTC with the offset made explicit, so
    // the time shown is never silently wrong.
    return new Intl.DateTimeFormat(locale || 'en', { ...options, timeZone: 'UTC' }).format(date) + ' UTC';
  }
}

// Relative time ("in 3 days", "2 hours ago") via Intl.RelativeTimeFormat,
// choosing the best unit like the built-in examples do. Future phases render
// dates through this; defined now so the rule is single-sourced.
export function formatRelative(date, { locale, now = new Date() } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const base = now instanceof Date ? now : new Date();
  if (Number.isNaN(d.getTime()) || Number.isNaN(base.getTime())) return '';
  const diffSeconds = (d.getTime() - base.getTime()) / 1000;
  const absSeconds = Math.abs(diffSeconds);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' });
    if (absSeconds < 60) return rtf.format(Math.round(diffSeconds), 'second');
    const diffMinutes = diffSeconds / 60;
    if (absSeconds < 3600) return rtf.format(Math.round(diffMinutes), 'minute');
    const diffHours = diffMinutes / 60;
    if (absSeconds < 86400) return rtf.format(Math.round(diffHours), 'hour');
    const diffDays = diffHours / 24;
    if (absSeconds < 2592000) return rtf.format(Math.round(diffDays), 'day');
    if (absSeconds < 31536000) return rtf.format(Math.round(diffDays / 30), 'month');
    return rtf.format(Math.round(diffDays / 365), 'year');
  } catch {
    return formatDate(d, { locale });
  }
}
