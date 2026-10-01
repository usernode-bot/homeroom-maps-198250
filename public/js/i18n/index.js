// The browser-facing i18n singleton. Binds the pure core (core.js) to the
// real dependencies: guarded localStorage preferences (prefs.js), the
// platform bridge's locale, the device languages, dynamic locale-bundle
// imports, the document's lang/dir attributes and the shared state store.
//
// Resolution order (see resolve.js and the spec): stored in-app override →
// platform locale mapped onto the shipped set → device languages → English.
// A `?lang=` or `?dir=` URL override (read like home.js's demoState reads
// `?map=`) exists purely as a test/demo hook.
import { setState } from '../state.js';
import { createI18n } from './core.js';
import { mapToShipped, resolveInitialLocale } from './resolve.js';
import { readPref, writePref } from './prefs.js';
import { setUnitsPreference, resolveUnits } from './format.js';
import { SHIPPED, DEFAULT_LOCALE, directionFor } from './locales/registry.js';
import en from './locales/en.js';

const LANG_KEY = 'hm-language';
const UNITS_KEY = 'hm-units';
const LANG_PREFS = ['system', 'en', 'id'];
const UNITS_PREFS = ['system', 'metric', 'imperial'];

// ---- browser helpers (never called outside the browser) ----

// Device language tags, best first.
function deviceLocales() {
  if (typeof navigator === 'undefined') return [];
  return (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]).filter(Boolean);
}

// The device region ("US" out of "en-US"), used only for the System units
// resolution. null when the device exposes no region.
function deviceRegion() {
  const tag = deviceLocales()[0];
  if (!tag || typeof tag !== 'string' || !tag.includes('-')) return null;
  return tag.split('-').pop();
}

// Query overrides, readable both from the URL's own search string and from a
// query embedded after the hash (this app hash-routes; home.js's demoState
// does the same for ?map=).
function queryOverride(name) {
  try {
    let value = new URLSearchParams(window.location.search).get(name);
    if (!value) {
      const hash = window.location.hash.replace(/^#/, '');
      const q = hash.indexOf('?');
      if (q >= 0) value = new URLSearchParams(hash.slice(q + 1)).get(name);
    }
    return value;
  } catch {
    return null;
  }
}

function demoLang() {
  const value = queryOverride('lang');
  return value === 'en' || value === 'id' ? value : null;
}

function demoDir() {
  const value = queryOverride('dir');
  return value === 'rtl' || value === 'ltr' ? value : null;
}

// The platform-level locale. Cached here: filled by the bridge at init and
// updated whenever the app learns it from /api/me (notePlatformLocale).
let platformLocale = null;

// ---- the singleton ----

export const i18n = createI18n({
  fallbackBundle: en,
  loadBundle: async (code) => {
    if (code === 'en') return en; // always in memory: the permanent fallback
    const module = await import(`./locales/${code}.js`);
    return module.default;
  },
  resolveInitial: () => {
    // Demo override wins (it is a test hook, never user data).
    const forced = demoLang();
    if (forced) return { locale: forced, source: 'override' };
    return resolveInitialLocale({
      storedPref: readPref(LANG_KEY, LANG_PREFS, 'system'),
      platformLocale,
      deviceLocales: deviceLocales(),
      fallback: DEFAULT_LOCALE,
    });
  },
  applyLocale: (code) => {
    document.documentElement.lang = code;
    // No shipped locale is RTL, so the app never renders RTL unless a
    // supported RTL language ships; the explicit ?dir= demo override is the
    // only way to exercise the RTL path today.
    document.documentElement.dir = demoDir() || directionFor(code);
    setState({ language: code });
  },
});

// Resolve and apply the starting locale, the units preference, and follow the
// platform when it knows a language. Called once by app.js before the first
// render.
export async function init() {
  i18n.start();

  // Units preference: stored value resolved against the device region.
  setAppUnits(readPref(UNITS_KEY, UNITS_PREFS, 'system'));

  // Follow a mid-session platform change (the bridge dispatches
  // usernode:locale-changed when the user changes their Homeroom-level
  // setting; the shell re-renders via the onChange subscriber in app.js).
  window.addEventListener('usernode:locale-changed', (event) => {
    notePlatformLocale(event && event.detail && event.detail.locale);
  });

  // The bridge's own answer for the platform locale. It never rejects; when
  // it reports a language and the user has no in-app override, follow it.
  try {
    if (window.usernode && typeof window.usernode.getUserLocale === 'function') {
      const answer = await window.usernode.getUserLocale();
      notePlatformLocale(answer && answer.locale);
    }
  } catch {
    /* standalone or refused: the device/default resolution stands */
  }
}

// Learn the platform locale from a source outside the bridge (the `locale`
// claim /api/me already returns). Upgrades the active locale only when the
// user has no in-app override, per the platform convention.
export function notePlatformLocale(tag) {
  platformLocale = typeof tag === 'string' ? tag : platformLocale;
  if (demoLang()) return; // test hook pins the language
  if (readPref(LANG_KEY, LANG_PREFS, 'system') !== 'system') return; // override wins
  const mapped = mapToShipped(platformLocale);
  if (mapped && mapped !== i18n.getLocale()) {
    i18n.setLocale(mapped, { source: 'platform' });
  }
}

// The user-facing language picker. 'system' returns control to the platform
// and device; 'en'/'id' are explicit overrides that win over both.
export function setLanguage(pref) {
  if (pref !== 'system' && pref !== 'en' && pref !== 'id') return;
  writePref(LANG_KEY, pref);
  if (pref !== 'system') {
    i18n.setLocale(pref, { source: 'override' });
    return;
  }
  // 'system': re-resolve the chain with no override. The stored value stays
  // 'system' so the platform/device path remains live next boot.
  const forced = demoLang();
  const next = forced
    ? { locale: forced, source: 'platform' }
    : resolveInitialLocale({
        storedPref: 'system',
        platformLocale,
        deviceLocales: deviceLocales(),
        fallback: DEFAULT_LOCALE,
      });
  i18n.setLocale(next.locale, { source: forced ? 'platform' : next.source });
}

// The raw stored preference, for the picker's pressed state. 'system' (the
// default) is distinct from English on purpose: null/system never means
// English.
export function getLanguagePreference() {
  return readPref(LANG_KEY, LANG_PREFS, 'system');
}

// The units picker. 'system' follows the device region (metric everywhere
// except the documented imperial-first regions).
export function setAppUnits(pref) {
  if (!UNITS_PREFS.includes(pref)) return;
  writePref(UNITS_KEY, pref);
  setUnitsPreference(pref, deviceRegion());
  setState({ units: pref });
}

export function getUnitsPreference() {
  return readPref(UNITS_KEY, UNITS_PREFS, 'system');
}

// The units the active preference resolves to ('metric'|'imperial').
export function resolvedUnits() {
  return resolveUnits(getUnitsPreference(), deviceRegion());
}

// The language the search fetchers send upstream. English is deliberately
// omitted: with no lang param the server behaves exactly as Phase 2 shipped
// it (platform claim, then Accept-Language, then provider default), so
// English results are byte-identical with today's. Non-English locales pass
// their primary subtag so providers return localized naming.
export function searchLangParam() {
  const locale = i18n.getLocale();
  return locale && locale !== 'en' ? locale : null;
}

// Convenience passthroughs used across the UI.
export function t(key, params) {
  return i18n.t(key, params);
}

export function getLocale() {
  return i18n.getLocale();
}

// The shell re-renders the current screen on every locale change.
export function onChange(fn) {
  return i18n.subscribe(fn);
}
