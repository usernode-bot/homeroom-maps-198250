// Tests for the normalized Place model (places/place.js): normal, missing and
// invalid data all take the honest path — valid fields survive, unusable ones
// drop to null (or the entry is skipped), and nothing is ever invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePlace, validatePlace } = require('../places/place');

test('normalizePlace keeps every real field and fills the optional ones', () => {
  const place = normalizePlace({
    id: 'poi-1',
    name: 'Staging demo bakery',
    localizedNames: { de: 'Staging Demo Bäckerei' },
    category: 'food',
    subcategory: 'bakery',
    coordinates: { lat: 52.52, lon: 13.405 },
    address: 'Demostrasse 1, 10115 Berlin',
    country: 'Germany',
    phone: '+49 30 000000',
    website: 'https://example.com/bakery',
    openingHours: {
      status: 'open',
      weekdayText: ['Monday: 08:00–18:00', 'Tuesday: 08:00–18:00'],
    },
    rating: { value: 4.5, count: 123 },
    photos: [
      { id: 'p1', url: 'https://example.com/p1.jpg', width: 800, height: 600, attribution: 'Demo' },
    ],
    businessStatus: 'OPERATIONAL',
    verificationStatus: 'Verified',
    dataSource: 'staging-demo',
  });
  assert.ok(place);
  assert.equal(place.id, 'poi-1');
  assert.equal(place.name, 'Staging demo bakery');
  assert.deepEqual(place.localizedNames, { de: 'Staging Demo Bäckerei' });
  assert.equal(place.category, 'food');
  assert.equal(place.subcategory, 'bakery');
  assert.deepEqual(place.coordinates, { lat: 52.52, lon: 13.405 });
  assert.equal(place.address, 'Demostrasse 1, 10115 Berlin');
  assert.equal(place.country, 'Germany');
  assert.equal(place.phone, '+49 30 000000');
  assert.equal(place.website, 'https://example.com/bakery');
  assert.equal(place.openingHours.status, 'open'); // from provider data only
  assert.deepEqual(place.openingHours.weekdayText, ['Monday: 08:00–18:00', 'Tuesday: 08:00–18:00']);
  assert.deepEqual(place.rating, { value: 4.5, count: 123 });
  assert.equal(place.photos.length, 1);
  assert.equal(place.photos[0].attribution, 'Demo');
  assert.equal(place.businessStatus, 'operational'); // casing normalized, value real
  assert.equal(place.verificationStatus, 'verified');
  assert.equal(place.dataSource, 'staging-demo');
  const check = validatePlace(place);
  assert.equal(check.ok, true);
  assert.deepEqual(check.problems, []);
});

test('normalizePlace drops a place without an id or a name', () => {
  assert.equal(normalizePlace(null), null);
  assert.equal(normalizePlace('nope'), null);
  assert.equal(normalizePlace({ name: 'No id' }), null);
  assert.equal(normalizePlace({ id: 'x', name: '   ' }), null);
});

test('normalizePlace returns null coordinates for missing or invalid ones', () => {
  const base = { id: 'x', name: 'Place' };
  assert.equal(normalizePlace({ ...base, coordinates: null }).coordinates, null);
  assert.equal(normalizePlace({ ...base, coordinates: {} }).coordinates, null);
  assert.equal(
    normalizePlace({ ...base, coordinates: { lat: 'nan', lon: 0 } }).coordinates,
    null,
  );
  // Out of range is invalid, not clamped: the UI renders the unavailable state.
  assert.equal(
    normalizePlace({ ...base, coordinates: { lat: 95, lon: 0 } }).coordinates,
    null,
  );
  assert.equal(
    normalizePlace({ ...base, coordinates: { lat: 0, lon: -200 } }).coordinates,
    null,
  );
  assert.deepEqual(
    normalizePlace({ ...base, coordinates: { lat: 0, lon: 0 } }).coordinates,
    { lat: 0, lon: 0 },
  );
});

test('openingHours status comes only from provider data, never from the clock', () => {
  const base = { id: 'x', name: 'Place' };
  // weekdayText alone never implies a status.
  assert.deepEqual(normalizePlace({
    ...base,
    openingHours: { weekdayText: ['Monday: 09:00–17:00'] },
  }).openingHours, { status: null, weekdayText: ['Monday: 09:00–17:00'] });
  // The provider's own open-now boolean translates, it is not computed.
  assert.equal(normalizePlace({ ...base, openNow: true }).openingHours.status, 'open');
  assert.equal(normalizePlace({ ...base, openNow: false }).openingHours.status, 'closed');
  // An explicit status wins over the boolean.
  assert.equal(
    normalizePlace({ ...base, openNow: true, openingHours: { status: 'closed' } }).openingHours.status,
    'closed',
  );
  // Unknown status strings are dropped, never guessed at.
  assert.equal(normalizePlace({ ...base, openingHours: { status: 'probably-open' } }).openingHours, null);
  // Nothing at all stays null.
  assert.equal(normalizePlace(base).openingHours, null);
});

test('rating is kept only when real and in range; nothing is fabricated', () => {
  const base = { id: 'x', name: 'Place' };
  assert.equal(normalizePlace(base).rating, null);
  assert.equal(normalizePlace({ ...base, rating: null }).rating, null);
  assert.equal(normalizePlace({ ...base, rating: { value: 0 } }).rating, null);
  assert.equal(normalizePlace({ ...base, rating: { value: 5.1 } }).rating, null);
  assert.equal(normalizePlace({ ...base, rating: { value: 'high' } }).rating, null);
  assert.deepEqual(normalizePlace({ ...base, rating: { value: 3 } }).rating, { value: 3, count: null });
  assert.deepEqual(
    normalizePlace({ ...base, rating: { value: 4, count: -2 } }).rating,
    { value: 4, count: null },
  );
});

test('photos without a usable URL are dropped, not repaired', () => {
  const photos = normalizePlace({
    id: 'x',
    name: 'Place',
    photos: [
      { url: 'https://ok.example/a.jpg' },
      { url: 'ftp://not-http.example/b.jpg' },
      { url: 'javascript:alert(1)' },
      { noUrl: true },
      'garbage',
      { url: '  https://spaced.example/c.jpg  ' },
    ],
  }).photos;
  assert.deepEqual(
    photos.map((p) => p.url),
    ['https://ok.example/a.jpg', 'https://spaced.example/c.jpg'],
  );
});

test('website without a scheme is dropped rather than guessed', () => {
  const base = { id: 'x', name: 'Place' };
  assert.equal(normalizePlace({ ...base, website: 'example.com' }).website, null);
  assert.equal(normalizePlace({ ...base, website: 'https://example.com' }).website, 'https://example.com');
  assert.equal(normalizePlace({ ...base, website: 'http://example.com' }).website, 'http://example.com');
});

test('unknown enum values drop to null; empty strings and blanks never survive', () => {
  const place = normalizePlace({
    id: ' x ',
    name: '  Padded name  ',
    businessStatus: 'demolished',
    verificationStatus: 'kind-of',
    category: '  ',
    address: '',
    localizedNames: { '': 'no tag', en: '' },
  });
  assert.equal(place.id, 'x');
  assert.equal(place.name, 'Padded name');
  assert.equal(place.businessStatus, null);
  assert.equal(place.verificationStatus, null);
  assert.equal(place.category, null);
  assert.equal(place.address, null);
  assert.equal(place.localizedNames, null);
  assert.equal(place.dataSource, 'unknown');
});

test('validatePlace reports concrete problems on a tampered place', () => {
  assert.deepEqual(validatePlace(null), { ok: false, problems: ['place is not an object'] });
  const bad = {
    id: '',
    name: 'Broken',
    coordinates: { lat: 120, lon: 10 },
    rating: { value: 9, count: -1 },
    photos: [{ url: 'not-a-url' }],
    openingHours: { status: 'sometimes' },
    businessStatus: 'haunted',
    verificationStatus: 'maybe',
  };
  const check = validatePlace(bad);
  assert.equal(check.ok, false);
  assert.ok(check.problems.includes('id is required'));
  assert.ok(check.problems.includes('coordinates are out of range'));
  assert.ok(check.problems.includes('rating.value must be within (0, 5]'));
  assert.ok(check.problems.includes('rating.count must be a non-negative integer'));
  assert.ok(check.problems.includes('photos[0] needs an http(s) URL'));
  assert.ok(check.problems.includes('openingHours.status is not a known status'));
  assert.ok(check.problems.includes('businessStatus is not a known status'));
  assert.ok(check.problems.includes('verificationStatus is not a known status'));
});