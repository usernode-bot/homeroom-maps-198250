// Tests for the selected search place → map view helper (map/selected-place.js).
// The module is browser ESM with zero imports, loaded here via dynamic import
// (Node detects the module syntax), so no DOM and no map renderer are needed.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The result the search stack normalized for "Sulawesi Selatan" (issue #40):
// lat/lon, as the server and the offline results both carry.
const SULAWESI_SELATAN = {
  id: 'osm:123',
  kind: 'region',
  name: 'Sulawesi Selatan',
  detail: 'Indonesia',
  lat: -3.64467,
  lon: 119.94719,
};

test('selectedPlaceView maps lon to lng without swapping', async () => {
  const { selectedPlaceView } = await import('../public/js/map/selected-place.js');
  const view = selectedPlaceView(SULAWESI_SELATAN);
  assert.deepStrictEqual(view.center, { lat: -3.64467, lng: 119.94719 });
  assert.equal(view.zoom, 14);
  assert.equal(view.markers.length, 1);
  assert.deepStrictEqual(view.markers[0], { lat: -3.64467, lng: 119.94719, label: '' });
});

test('selectedPlaceView coerces numeric strings', async () => {
  const { selectedPlaceView } = await import('../public/js/map/selected-place.js');
  const view = selectedPlaceView({ lat: '-3.5', lon: '119.9' });
  assert.deepStrictEqual(view.center, { lat: -3.5, lng: 119.9 });
});

test('selectedPlaceView accepts the range edges', async () => {
  const { selectedPlaceView } = await import('../public/js/map/selected-place.js');
  assert.ok(selectedPlaceView({ lat: -90, lon: -180 }));
  assert.ok(selectedPlaceView({ lat: 90, lon: 180 }));
  assert.ok(selectedPlaceView({ lat: 0, lon: 0 }));
});

test('selectedPlaceView rejects unusable positions', async () => {
  const { selectedPlaceView } = await import('../public/js/map/selected-place.js');
  assert.equal(selectedPlaceView({ lat: NaN, lon: 119.9 }), null);
  assert.equal(selectedPlaceView({ lat: -3.6 }), null); // missing lon
  assert.equal(selectedPlaceView({ lat: 95, lon: 119.9 }), null); // lat out of range
  assert.equal(selectedPlaceView({ lat: -3.6, lon: 200 }), null); // lon out of range
  assert.equal(selectedPlaceView(null), null);
  assert.equal(selectedPlaceView(undefined), null);
  assert.equal(selectedPlaceView('not a place'), null);
});
