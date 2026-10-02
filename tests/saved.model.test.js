// Saved places model and client mapping — pure, no database.
//
// Covers the rules the server enforces (saved/model.js) and the two client
// mappers that turn a real search result into a stored reference and a stored
// row back into the app's Place model (services/saved-places.js). Also asserts
// the wired adapter satisfies the SavedPlacesAdapter contract the repo already
// documented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../saved/model');

// Browser ESM modules, loaded lazily: a CommonJS file may not carry a
// top-level await (Node 22 refuses the mix).
let savedPlacesModule = null;
async function loadClient() {
  if (!savedPlacesModule) {
    // The service imports the app's fetch wrapper, which imports auth.js; that
    // module reads the frame's URL for the platform token. A minimal window is
    // all those two need at module-load time (no call is made here).
    if (typeof globalThis.window === 'undefined') {
      globalThis.window = { location: { search: '' } };
    }
    savedPlacesModule = await import('../public/js/services/saved-places.js');
  }
  return savedPlacesModule;
}
function clientTest(name, fn) {
  return test(name, async (t) => {
    const mod = await loadClient();
    return fn(t, mod);
  });
}

test('the four default lists are exactly the ones the spec names', () => {
  assert.deepEqual(model.DEFAULT_LIST_SLUGS, ['favorites', 'want_to_visit', 'travel', 'restaurants']);
  for (const list of model.DEFAULT_LISTS) {
    assert.ok(list.name);
    assert.ok(model.isDefaultSlug(list.slug));
  }
  assert.equal(model.isDefaultSlug('nope'), false);
});

test('a saved place must carry a real id and never fabricates display data', () => {
  const ok = model.validateSave({ place: { id: 'photon:osm.node.1', name: 'A' } });
  assert.equal(ok.place.id, 'photon:osm.node.1');
  assert.equal(ok.place.name, 'A');
  assert.equal(ok.place.address, null); // absent stays null, never invented
  assert.equal(ok.place.lat, null);
  assert.equal(ok.listSlug, null);

  assert.throws(() => model.validateSave({ place: { name: 'No id' } }), (err) => {
    assert.equal(err.code, 'invalid_save');
    assert.ok(err.fields.place);
    return true;
  });
  assert.throws(() => model.validateSave({}), (err) => err.code === 'invalid_save');
});

test('coordinates must be complete and in range, or absent', () => {
  assert.throws(() => model.validateSave({ place: { id: 'x', lat: 52 } }), (e) => Boolean(e.fields.place));
  assert.throws(() => model.validateSave({ place: { id: 'x', lat: 200, lng: 13 } }), (e) => Boolean(e.fields.place));
  const both = model.validateSave({ place: { id: 'x', lat: 52.5, lng: 13.4 } });
  assert.equal(both.place.lat, 52.5);
});

test('list names are length-checked; ids are positive integers', () => {
  assert.equal(model.validateCreateList({ name: '  Weekend   trips ' }).name, 'Weekend trips');
  assert.throws(() => model.validateCreateList({ name: '   ' }), (e) => Boolean(e.fields.name));
  assert.throws(() => model.validateCreateList({ name: 'x'.repeat(200) }), (e) => Boolean(e.fields.name));
  assert.throws(() => model.validateUpdateList({}), (e) => Boolean(e.fields.name));

  assert.equal(model.validateListId('42'), 42);
  for (const bad of ['0', '-1', 'abc', '1.5', '+12', '1_2', '12ab']) {
    assert.throws(() => model.validateListId(bad), (e) => e.code === 'invalid_request');
  }
  // Surrounding whitespace is trimmed, the way every other text field is.
  assert.equal(model.validateListId(' 12 '), 12);
  assert.equal(model.validatePlaceId(' photon:1 '), 'photon:1');
  assert.throws(() => model.validatePlaceId(''), (e) => e.code === 'invalid_request');
});

clientTest('placeRef sends only real fields from a Place', (t, mod) => {
  const place = {
    id: 'photon:osm.node.9',
    name: 'Bakery',
    address: 'Kastanienallee 12',
    category: 'place',
    subcategory: 'poi',
    coordinates: { lat: 52.5, lon: 13.4 },
    dataSource: 'photon',
    rating: null,
  };
  assert.deepEqual(mod.placeRef(place), {
    id: 'photon:osm.node.9',
    name: 'Bakery',
    address: 'Kastanienallee 12',
    category: 'place',
    subcategory: 'poi',
    lat: 52.5,
    lng: 13.4,
    source: 'photon',
  });
  assert.equal(mod.placeRef({ name: 'no id' }), null);
  assert.equal(mod.placeRef(null), null);
});

clientTest('savedToPlace builds a Place the shared card can render', (t, mod) => {
  const place = mod.savedToPlace({
    id: 'photon:osm.node.9',
    name: 'Bakery',
    address: 'Kastanienallee 12',
    category: 'place',
    subcategory: 'poi',
    lat: 52.5,
    lng: 13.4,
    source: 'photon',
  });
  assert.equal(place.id, 'photon:osm.node.9');
  assert.deepEqual(place.coordinates, { lat: 52.5, lon: 13.4 });
  // Every optional field is present and empty/null: nothing invented.
  assert.equal(place.rating, null);
  assert.deepEqual(place.photos, []);
  assert.equal(place.phone, null);
  assert.equal(mod.savedToPlace(null), null);
});

clientTest('the wired service satisfies the SavedPlacesAdapter contract', async (t, mod) => {
  // createSavedPlacesService (services/saved.js) validates the adapter at the
  // wiring site; importing the module already ran that validation.
  for (const method of ['save', 'unsave', 'isSaved', 'list']) {
    assert.equal(typeof mod.savedPlaces[method], 'function', method);
  }
  assert.deepEqual(mod.DEFAULT_LIST_SLUGS, ['favorites', 'want_to_visit', 'travel', 'restaurants']);
});
