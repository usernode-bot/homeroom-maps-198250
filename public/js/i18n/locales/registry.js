// The locale registry — every language this app knows about, shipped or not.
//
// Adding a shipped language is one entry here plus one bundle file in this
// directory; no UI component changes. An entry with `translated: false` (an
// RTL or other script prepared for later) is deliberately listed so the
// architecture records the intent, but it is NEVER selectable and no UI ever
// claims it is supported: no bundle exists, so selecting it would be a fake
// translation.
//
// `label` is the language's own endonym and is never translated — a picker
// always shows each language in itself.
export const SHIPPED = {
  en: { label: 'English', dir: 'ltr', translated: true },
  id: { label: 'Bahasa Indonesia', dir: 'ltr', translated: true },
};

// Prepared, not claimed: recorded for RTL/script readiness only.
export const PREPARED = [
  { code: 'ar', label: 'العربية', dir: 'rtl', translated: false },
];

// The permanent fallback. The English bundle is statically imported by the
// i18n core, so a missing key anywhere always has an English answer.
export const DEFAULT_LOCALE = 'en';

export function isShipped(code) {
  return Object.prototype.hasOwnProperty.call(SHIPPED, code);
}

// Text direction for a locale code. Unknown codes fall back to LTR, which is
// correct for every shipped locale; the explicit `?dir=` demo override in
// i18n/index.js is the only way to exercise RTL layout until an RTL language
// actually ships.
export function directionFor(code) {
  return (SHIPPED[code] && SHIPPED[code].dir) || 'ltr';
}
