// Tests for the client-side places model (places-model.js) — the documented
// Search→Places interface — and the Place Detail session (place-detail.js).
// Both are browser ESM with no DOM dependency, loaded here via dynamic import
// (Node 22 detects the module syntax), the same pattern the search session
// tests use.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Browser ESM modules, loaded lazily inside each test: a CommonJS file may
// not carry a top-level await (Node 22 refuses the mix), so each test awaits
// loadModules() first.
let model = null;
let createPlaceDetailSession = null;
async function loadModules() {
  if (model) return;
  model = await import('../public/js/services/places-model.js');
  ({ createPlaceDetailSession } = await import('../public/js/services/place-detail.js'));
}
function placesTest(name, fn) {
  return test(name, async (t) => {
    await loadModules();
    return fn(t);
  });
}

// A normalized search result, exactly the shape search/normalize.js returns.
function result(overrides = {}) {
  return {
    id: 'res-1',
    kind: 'city',
    name: 'Berlin',
    localName: null,
    detail: 'City, Berlin, Germany',
    address: { houseNumber: null, street: null, city: 'Berlin', state: 'Berlin', postcode: null, country: 'Germany', countryCode: 'DE' },
    addressLine: null,
    lat: 52.52,
    lon: 13.405,
    provider: 'photon',
    ...overrides,
  };
}

// ---- Search→Places adapter ----

placesTest('placeFromSearchResult maps a search result into the Place model, summary depth', () => {
  const place = model.placeFromSearchResult(result({
    addressLine: 'Berlin, Germany',
    localName: 'Berlin (local)',
  }));
  assert.equal(place.id, 'res-1');
  assert.equal(place.name, 'Berlin');
  assert.deepEqual(place.localizedNames, { und: 'Berlin (local)' });
  assert.equal(place.category, 'locality');
  assert.equal(place.subcategory, 'city');
  assert.deepEqual(place.coordinates, { lat: 52.52, lon: 13.405 });
  assert.equal(place.address, 'Berlin, Germany');
  assert.equal(place.country, 'Germany');
  // Detail depth is never invented from a summary.
  assert.equal(place.phone, null);
  assert.equal(place.website, null);
  assert.equal(place.openingHours, null);
  assert.equal(place.rating, null);
  assert.deepEqual(place.photos, []);
  assert.equal(place.businessStatus, null);
  assert.equal(place.verificationStatus, null);
  assert.equal(place.dataSource, 'photon');
  assert.equal(place.distanceKm, undefined); // no reference point, no distance
});

placesTest('placeFromSearchResult composes an address line from real parts when none was given', () => {
  const place = model.placeFromSearchResult(result({
    kind: 'address',
    addressLine: null,
    address: {
      houseNumber: '12', street: 'Demo Street', city: 'Demo City',
      state: null, postcode: '10115', country: 'Germany', countryCode: 'DE',
    },
  }));
  assert.equal(place.category, 'address');
  assert.equal(place.subcategory, 'address');
  assert.equal(place.address, '12 Demo Street, 10115 Demo City, Germany');
});

placesTest('placeFromSearchResult attaches distance only with a reference point, display-only', () => {
  const withRef = model.placeFromSearchResult(result(), { reference: { lat: 52.52, lon: 13.405 } });
  assert.equal(withRef.distanceKm, 0);
  const far = model.placeFromSearchResult(result({ lat: 48.85, lon: 2.35 }), {
    reference: { lat: 52.52, lon: 13.405 },
  });
  assert.ok(far.distanceKm > 800 && far.distanceKm < 900);
  assert.equal(model.placeFromSearchResult(result({ lat: 'x', lon: 'y' })).coordinates, null);
});

placesTest('placeFromSearchResult returns null for unusable input, like the search stack', () => {
  assert.equal(model.placeFromSearchResult(null), null);
  assert.equal(model.placeFromSearchResult('junk'), null);
  assert.equal(model.placeFromSearchResult({ name: '' }), null);
  assert.equal(model.placeFromSearchResult({ name: 'No id, no coords' }), null);
  // A coordinate pair becomes the id when the provider sent none.
  assert.equal(model.placeFromSearchResult({ name: 'X', lat: 1, lon: 2 }).id, '1,2');
});

// ---- merge ----

placesTest('mergePlace overlays real detail onto the summary without losing summary fields', () => {
  const summary = model.placeFromSearchResult(result({ addressLine: 'Berlin, Germany' }));
  const details = {
    phone: '+49 30 000000',
    website: 'https://berlin.example',
    openingHours: { status: 'open', weekdayText: ['Monday: 00:00–24:00'] },
    rating: { value: 4.4, count: 99 },
    photos: [{ url: 'https://example.com/tv.jpg' }],
    businessStatus: 'operational',
    verificationStatus: 'verified',
    address: null, // the detail carries no address line; the summary's survives
  };
  const merged = model.mergePlace(summary, details);
  assert.equal(merged.phone, '+49 30 000000');
  assert.equal(merged.website, 'https://berlin.example');
  assert.equal(merged.openingHours.status, 'open');
  assert.deepEqual(merged.rating, { value: 4.4, count: 99 });
  assert.deepEqual(merged.photos, [{ url: 'https://example.com/tv.jpg' }]);
  assert.equal(merged.address, 'Berlin, Germany'); // summary field kept
  assert.equal(merged.country, 'Germany');
  assert.equal(merged.dataSource, 'photon');
  assert.equal(merged.verificationStatus, 'verified');
  // The summary object is never mutated in place.
  assert.equal(summary.phone, null);
  // Distance survives as the display-only field it is.
  const withDistance = model.placeFromSearchResult(result(), { reference: { lat: 52.52, lon: 13.405 } });
  assert.equal(model.mergePlace(withDistance, details).distanceKm, 0);
});

placesTest('mergePlace keeps the summary when the detail is null or empty', () => {
  const summary = model.placeFromSearchResult(result());
  assert.equal(model.mergePlace(summary, null), summary);
  assert.equal(model.mergePlace(summary, {}).name, 'Berlin');
});

// ---- display labels ----

placesTest('display labels render only real data and nothing else', () => {
  assert.equal(model.categoryLabel(model.placeFromSearchResult(result({ kind: 'town' }))), 'Town');
  assert.equal(model.categoryLabel(model.placeFromSearchResult(result({ kind: 'other' }))), 'Place');
  assert.equal(model.categoryLabel({ category: 'restaurant' }), 'Restaurant');
  assert.equal(model.categoryLabel({}), null);
  assert.equal(model.businessStatusLabel('closed_temporarily'), 'Temporarily closed');
  assert.equal(model.businessStatusLabel('operational'), null); // nothing to act on
  assert.equal(model.businessStatusLabel('nonsense'), null);
  assert.equal(model.verificationStatusLabel('verified'), 'Verified');
  assert.equal(model.openingHoursStatusLabel('opening_later'), 'Opens later');
  assert.equal(model.openingHoursStatusLabel(null), null);
  assert.equal(model.ratingLabel({ value: 4.25, count: 3 }), '4.3');
  assert.equal(model.ratingLabel(null), null);
  assert.equal(model.ratingLabel({ value: 7 }), null);
  assert.equal(model.ratingCountLabel(0), null);
  assert.equal(model.ratingCountLabel(12), '12 ratings');
  assert.equal(model.NOT_AVAILABLE, 'Not available');
});

placesTest('distance labels read metres below a kilometre and km above', () => {
  assert.equal(model.distanceLabel(0), '0 m');
  assert.equal(model.distanceLabel(0.42), '420 m');
  assert.equal(model.distanceLabel(1.234), '1.2 km');
  assert.equal(model.distanceLabel(87.6), '87.6 km');
  assert.equal(model.distanceLabel(140), '140 km');
  assert.equal(model.distanceLabel(-1), null);
  assert.equal(model.distanceLabel('x'), null);
  assert.equal(model.distanceLabel(null), null);
});

// ---- Place Detail session ----

placesTest('the detail session loads, merges and reaches ready', async () => {
  const summary = model.placeFromSearchResult(result());
  const updates = [];
  const session = createPlaceDetailSession({
    place: summary,
    fetchDetails: async () => ({ phone: '+49 30 111111' }),
  });
  session.subscribe((snap) => updates.push(snap.phase));
  await session.start();
  assert.equal(session.getState().phase, 'ready');
  assert.equal(session.getState().place.phone, '+49 30 111111');
  assert.equal(session.getState().place.name, 'Berlin'); // summary field kept
  assert.deepEqual(updates, ['loading', 'ready']);
});

placesTest('a null detail answer is a ready state with the summary, not an error', async () => {
  const session = createPlaceDetailSession({
    place: model.placeFromSearchResult(result()),
    fetchDetails: async () => null,
  });
  await session.start();
  assert.equal(session.getState().phase, 'ready');
  assert.equal(session.getState().place.name, 'Berlin');
});

placesTest('not_configured is the honest unavailable state, not a failure', async () => {
  const err = new Error('No place provider is connected yet.');
  err.code = 'not_configured';
  const session = createPlaceDetailSession({
    place: model.placeFromSearchResult(result()),
    fetchDetails: async () => {
      throw err;
    },
  });
  await session.start();
  assert.equal(session.getState().phase, 'unavailable');
  assert.equal(session.getState().error, null);
  // The summary still renders from this state.
  assert.equal(session.getState().place.name, 'Berlin');
});

placesTest('other failures land in error, and retry recovers', async () => {
  let attempt = 0;
  const err = new Error('The place provider could not be reached.');
  err.code = 'provider_error';
  const session = createPlaceDetailSession({
    place: model.placeFromSearchResult(result()),
    fetchDetails: async () => {
      attempt += 1;
      if (attempt === 1) throw err;
      return { rating: { value: 3.5, count: 4 } };
    },
  });
  await session.start();
  assert.equal(session.getState().phase, 'error');
  assert.equal(session.getState().error.code, 'provider_error');
  await session.retry();
  assert.equal(session.getState().phase, 'ready');
  assert.deepEqual(session.getState().place.rating, { value: 3.5, count: 4 });
});

placesTest('stale answers from an older fetch never win', async () => {
  // Each call parks its resolver in `pending`; the test releases them in order.
  const pending = [];
  const session = createPlaceDetailSession({
    place: model.placeFromSearchResult(result()),
    fetchDetails: () => new Promise((res) => pending.push(res)),
  });
  const first = session.start();
  const second = session.retry(); // supersedes the first fetch
  pending[0]({ phone: 'stale' }); // the older fetch answers after the newer one started
  await first;
  // The newer fetch is still pending: phase stays loading until it settles.
  assert.equal(session.getState().phase, 'loading');
  pending[1]({ phone: 'fresh' });
  await second;
  assert.equal(session.getState().phase, 'ready');
  assert.equal(session.getState().place.phone, 'fresh');
});

placesTest('the session refuses to exist without a usable place or fetcher', () => {
  assert.throws(() => createPlaceDetailSession({ place: null, fetchDetails: async () => null }));
  assert.throws(() => createPlaceDetailSession({ place: { name: 'no id' }, fetchDetails: async () => null }));
  assert.throws(() => createPlaceDetailSession({ place: model.placeFromSearchResult(result()) }));
});