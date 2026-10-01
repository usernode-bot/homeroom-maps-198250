// Country and region naming.
//
// No country name table is invented or hardcoded: localized country names
// come from the browser's built-in Intl.DisplayNames, which carries the full
// ISO 3166 region set in every locale. Regions/states are free-form strings
// exactly as the search and place providers supply them — the app never
// invents region data.
//
// Fallback order for a country name (spec): the provider-supplied country
// string wins, then Intl.DisplayNames in the active locale, then the raw
// code. An unknown code never renders as blank.
'use strict';

const displayNamesCache = new Map();

function displayNamesFor(locale) {
  const key = locale || 'en';
  if (!displayNamesCache.has(key)) {
    let dn = null;
    try {
      dn = new Intl.DisplayNames([key], { type: 'region' });
    } catch {
      dn = null; // malformed locale: fall back below
    }
    displayNamesCache.set(key, dn);
  }
  return displayNamesCache.get(key);
}

// "ID" + locale "id" -> the Indonesian name for Indonesia, e.g. "Indonesia".
// Returns null when the code is not a plausible 2-letter region code or
// DisplayNames has no entry (implementations differ for user-assigned codes:
// browsers echo the code back, some ICU builds return a placeholder — either
// way the caller falls back, and the result is never blank).
export function localizedCountryName(countryCode, { locale } = {}) {
  if (typeof countryCode !== 'string') return null;
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const dn = displayNamesFor(locale);
  if (!dn) return null;
  try {
    const name = dn.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

// The best display name for a country given what the provider sent and the
// active locale. `providerCountry` is the provider's own country string;
// `countryCode` the ISO alpha-2 code. Never returns blank while any input
// exists.
export function countryDisplayName({ providerCountry, countryCode }, { locale } = {}) {
  const provided = typeof providerCountry === 'string' ? providerCountry.trim() : '';
  if (provided) return provided;
  const localized = localizedCountryName(countryCode, { locale });
  if (localized) return localized;
  return typeof countryCode === 'string' ? countryCode.trim() : '';
}
