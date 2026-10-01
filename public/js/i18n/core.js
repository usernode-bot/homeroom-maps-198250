// The i18n core — a pure, dependency-injected factory with no browser
// globals, so node:test can drive the whole fallback chain (the same pattern
// as services/search-session.js).
//
// Behaviors pinned here:
//   - t() never returns blank: active bundle, then the English fallback, then
//     the raw key as the last resort.
//   - {name}-style interpolation; an unknown placeholder stays visible rather
//     than swallowing surrounding text.
//   - setLocale loads a bundle through the injected loader; a failed load
//     keeps the current locale active (English stays when it was active) and
//     the app remains fully usable.
//   - applyLocale (injected) runs after every successful switch; subscribers
//     are notified so the shell can re-render the current screen.
'use strict';

const FALLBACK_KEY = 'en';

// Interpolate {name} placeholders. Missing params are left as-is so a bug
// announces itself instead of silently rendering an empty spot.
export function interpolate(template, params) {
  if (!params || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) && params[key] != null
      ? String(params[key])
      : match,
  );
}

export function createI18n({
  fallbackBundle,   // the statically imported English bundle (required)
  loadBundle,       // async (code) -> bundle; throws on failure
  resolveInitial,   // () -> { locale, source }; the caller owns resolution
  applyLocale,      // optional (code) -> side effects (html lang/dir, state)
} = {}) {
  if (!fallbackBundle || typeof loadBundle !== 'function' || typeof resolveInitial !== 'function') {
    throw new Error('createI18n requires fallbackBundle, loadBundle and resolveInitial');
  }
  // English is present from the start: it is the permanent fallback.
  const bundles = { [FALLBACK_KEY]: fallbackBundle };
  let active = null;
  let source = 'device';
  const listeners = new Set();

  function t(key, params) {
    const primary = bundles[active];
    const value = (primary && primary[key]) ?? fallbackBundle[key];
    if (typeof value !== 'string') return key; // never blank
    return interpolate(value, params);
  }

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn(active);
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function setLocale(code, { source: src } = {}) {
    if (!code) return active;
    if (code === active) {
      if (src) source = src;
      return active;
    }
    if (!bundles[code]) {
      try {
        bundles[code] = await loadBundle(code);
      } catch (err) {
        // A failed bundle load keeps the current locale active; the app is
        // fully usable and the picker simply shows this language as
        // unavailable. Never a broken UI.
        console.warn(`[i18n] bundle for "${code}" failed to load; staying on "${active}"`);
        return active;
      }
    }
    active = code;
    if (src) source = src;
    if (applyLocale) {
      try {
        applyLocale(code);
      } catch (err) {
        console.error(err);
      }
    }
    notify();
    return active;
  }

  // Resolve and apply the starting locale. The English bundle is in memory,
  // so English first paint is never delayed; a non-English start (the demo
  // override, or a platform/device language) loads its bundle here before the
  // change is announced, exactly like setLocale does.
  async function start() {
    const { locale, source: src } = resolveInitial();
    active = locale;
    source = src;
    if (applyLocale) {
      try {
        applyLocale(locale);
      } catch (err) {
        console.error(err);
      }
    }
    if (!bundles[locale]) {
      try {
        bundles[locale] = await loadBundle(locale);
      } catch (err) {
        console.warn(`[i18n] bundle for "${locale}" failed to load; staying on "${FALLBACK_KEY}"`);
        return active;
      }
    }
    notify();
    return active;
  }

  return {
    start,
    t,
    setLocale,
    getLocale: () => active,
    // Why the current locale is active: 'override' (in-app choice),
    // 'platform' (Homeroom-level setting) or 'device'.
    getSource: () => source,
    hasOverride: () => source === 'override',
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
