// Tests for international address composition (public/js/i18n/address.js) and
// country naming (public/js/i18n/countries.js). Ordering conventions only —
// the app never invents address data, so every fixture here is synthetic and
// only the ORDER of existing parts is asserted.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = (name) => import(`../public/js/i18n/${name}`);

// The exact normalized shape Phase 2's search service produces
// (search/normalize.js normalizeResult .address).
const FULL = {
  houseNumber: '12',
  street: 'Main Street',
  city: 'Springfield',
  state: 'Illinois',
  postcode: '62704',
  country: 'United States',
  countryCode: 'US',
};

test('the default international order: street line, city, state, postcode, country', async () => {
  const { formatAddress } = await load('address.js');
  assert.equal(
    formatAddress(FULL),
    'Main Street 12, Springfield, Illinois, 62704, United States',
  );
});

test('a country template reorders the same parts (postcode first, JP style)', async () => {
  const { formatAddress } = await load('address.js');
  assert.equal(
    formatAddress(FULL, { countryCode: 'JP' }),
    '62704, Illinois, Springfield, Main Street 12, United States',
  );
});

test('the country code comes from the address itself when no override is given', async () => {
  const { formatAddress } = await load('address.js');
  assert.equal(
    formatAddress({ ...FULL, countryCode: 'JP' }),
    '62704, Illinois, Springfield, Main Street 12, United States',
  );
});

test('missing parts are dropped without gaps', async () => {
  const { formatAddress } = await load('address.js');
  assert.equal(
    formatAddress({ street: 'Jalan Sudirman', houseNumber: '1', city: 'Jakarta', countryCode: 'ID' }),
    'Jalan Sudirman 1, Jakarta',
  );
  assert.equal(formatAddress({ city: 'Jakarta' }), 'Jakarta');
});

test('no usable parts means null, so the caller falls back to the provider line', async () => {
  const { formatAddress } = await load('address.js');
  assert.equal(formatAddress({}), null);
  assert.equal(formatAddress(null), null);
  assert.equal(formatAddress({ houseNumber: '   ' }), null);
});

test('a house number alone still composes', async () => {
  const { formatAddress } = await load('address.js');
  assert.equal(formatAddress({ houseNumber: '12' }), '12');
});

// ---- country naming (countries.js) ----

test('localized country names come from Intl.DisplayNames, no hardcoded table', async () => {
  const { localizedCountryName } = await load('countries.js');
  assert.equal(localizedCountryName('ID', { locale: 'en' }), 'Indonesia');
  assert.equal(localizedCountryName('US', { locale: 'id' }), 'Amerika Serikat');
  assert.equal(localizedCountryName('id', { locale: 'en' }), 'Indonesia'); // case-normalized
  // an implausible code yields null (the caller falls back), never a throw
  assert.equal(localizedCountryName('XX', { locale: 'en' }), null);
  assert.equal(localizedCountryName('Garbage', { locale: 'en' }), null);
  assert.equal(localizedCountryName(null, { locale: 'en' }), null);
});

test('countryDisplayName: the provider string wins, then DisplayNames, then the code', async () => {
  const { countryDisplayName } = await load('countries.js');
  assert.equal(
    countryDisplayName({ providerCountry: 'Indonesia', countryCode: 'ID' }, { locale: 'id' }),
    'Indonesia',
  );
  assert.equal(countryDisplayName({ providerCountry: '', countryCode: 'ID' }, { locale: 'id' }), 'Indonesia');
  // 'ZZ' is a user-assigned code with no real country: ICU builds disagree on
  // the exact string (browsers echo the code, some return a placeholder), so
  // the pinned guarantee is "never blank, never a throw", not the spelling.
  const unknown = countryDisplayName({ providerCountry: null, countryCode: 'ZZ' }, { locale: 'en' });
  assert.ok(unknown === 'ZZ' || /unknown region/i.test(unknown), `unexpected: ${unknown}`);
  assert.equal(countryDisplayName({}, { locale: 'en' }), '');
});
