// Pure locale resolution — no browser or network access, fully unit-testable
// under node:test (the same pattern as services/search-session.js).
//
// The documented resolution order (spec, mirroring the platform's "User
// language preference" convention):
//   1. an explicit in-app override (the stored preference) wins,
//   2. then the user's Homeroom-level platform locale, mapped onto the
//      shipped set,
//   3. then the device languages, mapped the same way,
//   4. then the app default.
// A stored preference of "system" and a platform locale of null both mean
// "no preference": neither is ever treated as English directly, so the
// device-language path stays live.
import { isShipped } from './locales/registry.js';

// Primary language subtag: "pt-BR" -> "pt". Client-side twin of the server's
// search/normalize.js primarySubtag (that module is CommonJS, the client is
// ESM, so the three lines are duplicated rather than shared).
export function primarySubtag(tag) {
  if (!tag) return null;
  const sub = String(tag).split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(sub) ? sub : null;
}

// Sanitize an untrusted locale tag. Returns the tag only when it is a
// plausible BCP-47 shape (canonicalized through Intl.Locale when available),
// or null for anything malformed, so a bad value can never throw into the UI
// and the resolution chain simply continues.
export function sanitizeLocaleTag(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(trimmed)) return null;
  if (typeof Intl !== 'undefined' && Intl.Locale) {
    try {
      return new Intl.Locale(trimmed).toString();
    } catch {
      return null;
    }
  }
  return trimmed;
}

// Map any locale tag onto the shipped set by language-subtag prefix:
// "pt-BR" -> "pt" (not shipped -> null), "id-ID" -> "id". Returns null when
// the tag is unusable or names no shipped language — the caller continues
// down the resolution chain rather than forcing a match.
export function mapToShipped(tag) {
  const clean = sanitizeLocaleTag(tag);
  const sub = primarySubtag(clean);
  return sub && isShipped(sub) ? sub : null;
}

// The one resolution function. `storedPref` is the raw stored value
// ('system' | 'en' | 'id' | anything unusable), `platformLocale` the
// Homeroom-level tag or null, `deviceLocales` the device's preferred list.
// Returns { locale, source } with locale guaranteed to be a shipped code.
export function resolveInitialLocale({
  storedPref,
  platformLocale,
  deviceLocales,
  fallback,
}) {
  const fallbackCode = isShipped(fallback) ? fallback : 'en';
  if (storedPref === 'en' || storedPref === 'id') {
    return { locale: storedPref, source: 'override' };
  }
  const platform = mapToShipped(platformLocale);
  if (platform) return { locale: platform, source: 'platform' };
  for (const tag of Array.isArray(deviceLocales) ? deviceLocales : []) {
    const mapped = mapToShipped(tag);
    if (mapped) return { locale: mapped, source: 'device' };
  }
  return { locale: fallbackCode, source: 'device' };
}
