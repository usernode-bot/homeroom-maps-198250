// International address formatting.
//
// Ordering conventions only — never address data. The input is exactly the
// normalized address shape Phase 2's search service produces
// (search/normalize.js normalizeResult: houseNumber, street, city, state,
// postcode, country, countryCode), so any search result or place that has
// been through the app's normalization can be composed without a new
// pipeline.
//
// A template is a list of part names in display order for that country
// convention. Countries without an entry use the default international
// order. Empty parts are dropped; when nothing usable remains the caller
// falls back to the provider's preformatted addressLine.
'use strict';

const DEFAULT_ORDER = ['street', 'houseNumber', 'city', 'state', 'postcode', 'country'];

// Japan-style: postal code leads, prefecture (state) then city, then the
// street block. US-style ordering happens to match the default template
// (street, city, state, postcode), so it needs no entry.
const ORDERS = {
  JP: ['postcode', 'state', 'city', 'street', 'houseNumber', 'country'],
};

function pick(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// The street line: house number follows the street name in most conventions
// the app serves; a country whose convention differs adds an entry with a
// composed street part when one is needed.
function streetLine(street, houseNumber) {
  if (street && houseNumber) return `${street} ${houseNumber}`;
  return street || houseNumber || null;
}

// Compose a one-line address. Returns null when no part is present, so the
// caller can fall back to whatever the provider already formatted.
export function formatAddress(address, { countryCode } = {}) {
  if (!address || typeof address !== 'object') return null;
  const code = pick(countryCode || address.countryCode);
  const order = (code && ORDERS[code.toUpperCase()]) || DEFAULT_ORDER;

  const parts = [];
  for (const name of order) {
    if (name === 'street') {
      const line = streetLine(pick(address.street), pick(address.houseNumber));
      if (line) parts.push(line);
    } else if (name === 'houseNumber') {
      // already folded into the street line
      continue;
    } else {
      const value = pick(address[name]);
      if (value) parts.push(value);
    }
  }
  return parts.length ? parts.join(', ') : null;
}
