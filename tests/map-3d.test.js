// The 3D map capability (Phase 12H): the pure resolver, the pitch clamps, the
// camera patch, the terrain source builder and the buildings detector.
// Fail-closed by construction — a missing, malformed or disabled config
// resolves with every capability false, never ready.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let threeD = null;
let terrainLayer = null;

test.before(async () => {
  threeD = await import('../public/js/map/three-d.js');
  terrainLayer = await import('../public/js/map/terrain-layer.js');
});

function configuredMap(overrides = {}) {
  return {
    configured: true,
    provider: 'maplibre',
    styleUrl: 'https://tiles.example/styles/liberty',
    capabilities: { rotation: true, pitch: true, terrain: false, ...(overrides.caps || {}) },
    threeD: {
      maxPitch: 60,
      terrainUrl: '',
      terrainAttribution: '',
      ...(overrides.threeD || {}),
    },
  };
}

test('a configured map with the camera switch on resolves ready with pitch', () => {
  const capability = threeD.resolveThreeDCapabilities({ config: configuredMap() });
  assert.equal(capability.stage, threeD.MAP_3D_STAGE.READY);
  assert.equal(capability.pitch, true);
  assert.equal(capability.terrain, false);
  assert.equal(capability.maxPitch, 60);
  assert.equal(capability.terrainUrl, null);
  assert.equal(capability.terrainAttribution, null);
});

test('a missing, unconfigured or malformed config resolves fail-closed', () => {
  for (const config of [null, undefined, {}, { configured: false, capabilities: { pitch: true } }, configuredMap({ caps: { pitch: 'yes' } })]) {
    const capability = threeD.resolveThreeDCapabilities({ config });
    assert.equal(capability.pitch, false, JSON.stringify(config));
    assert.equal(capability.terrain, false, JSON.stringify(config));
  }
});

test('stages: disabled on a configured map with everything off, not_configured without a map', () => {
  const disabled = threeD.resolveThreeDCapabilities({
    config: configuredMap({ caps: { pitch: false } }),
  });
  assert.equal(disabled.stage, threeD.MAP_3D_STAGE.DISABLED);
  const notConfigured = threeD.resolveThreeDCapabilities({
    config: { configured: false, provider: null, styleUrl: null, capabilities: {}, threeD: null },
  });
  assert.equal(notConfigured.stage, threeD.MAP_3D_STAGE.NOT_CONFIGURED);
});

test('the three capability flags are independent', () => {
  // Terrain on without the camera: pitch stays false.
  const terrainOnly = threeD.resolveThreeDCapabilities({
    config: configuredMap({
      caps: { pitch: false, terrain: true },
      threeD: { terrainUrl: 'https://tiles.example/terrarium/{z}/{x}/{y}.png', terrainAttribution: 'Mapzen, Mapbox, OpenStreetMap' },
    }),
  });
  assert.equal(terrainOnly.pitch, false);
  assert.equal(terrainOnly.terrain, true);

  // Camera on without terrain: terrain stays false.
  const pitchOnly = threeD.resolveThreeDCapabilities({
    config: configuredMap({
      caps: { pitch: true, terrain: false },
      threeD: { terrainUrl: 'https://tiles.example/terrarium/{z}/{x}/{y}.png', terrainAttribution: '' },
    }),
  });
  assert.equal(pitchOnly.pitch, true);
  assert.equal(pitchOnly.terrain, false);
});

test('a terrain URL without its attribution line keeps terrain off', () => {
  const cases = [
    { terrainUrl: 'https://tiles.example/terrarium/{z}/{x}/{y}.png', terrainAttribution: '' },
    { terrainUrl: '', terrainAttribution: 'Mapzen, Mapbox, OpenStreetMap' },
    { terrainUrl: '   ', terrainAttribution: 'Mapzen, Mapbox, OpenStreetMap' },
  ];
  for (const threeDOverride of cases) {
    const capability = threeD.resolveThreeDCapabilities({
      config: configuredMap({ caps: { terrain: true }, threeD: threeDOverride }),
    });
    assert.equal(capability.terrain, false, JSON.stringify(threeDOverride));
    assert.equal(capability.terrainUrl, null);
  }
});

test('a complete terrain pair resolves with the URL and attribution exposed', () => {
  const capability = threeD.resolveThreeDCapabilities({
    config: configuredMap({
      caps: { terrain: true },
      threeD: { terrainUrl: 'https://tiles.example/terrarium/{z}/{x}/{y}.png', terrainAttribution: 'Mapzen, Mapbox, OpenStreetMap' },
    }),
  });
  assert.equal(capability.terrain, true);
  assert.equal(capability.terrainUrl, 'https://tiles.example/terrarium/{z}/{x}/{y}.png');
  assert.equal(capability.terrainAttribution, 'Mapzen, Mapbox, OpenStreetMap');
});

test('the configured max pitch clamps into [0, 85] and falls back to 60', () => {
  assert.equal(threeD.clampMaxPitch('60'), 60);
  assert.equal(threeD.clampMaxPitch('85'), 85);
  assert.equal(threeD.clampMaxPitch('90'), 85);
  assert.equal(threeD.clampMaxPitch('-5'), 0);
  assert.equal(threeD.clampMaxPitch('not a number'), 60);
  assert.equal(threeD.clampMaxPitch(null), 60);
  assert.equal(threeD.clampMaxPitch('17.4'), 17);
});

test('a configured max pitch of 0 keeps the camera capability off', () => {
  const capability = threeD.resolveThreeDCapabilities({
    config: configuredMap({ threeD: { maxPitch: 0 } }),
  });
  assert.equal(capability.pitch, false);
  assert.equal(capability.maxPitch, 0);
});

test('a single pitch request clamps into [0, maxPitch]', () => {
  assert.equal(threeD.clampPitch(55, 60), 55);
  assert.equal(threeD.clampPitch(70, 60), 60);
  assert.equal(threeD.clampPitch(-10, 60), 0);
  assert.equal(threeD.clampPitch(70, 85), 70);
  assert.equal(threeD.clampPitch('bad', 60), 0);
});

test('the 3D camera patch eases to the on pitch, clamped to the configured max', () => {
  assert.deepEqual(threeD.threeDCameraPatch(true, { maxPitch: 60 }), { pitch: 55, duration: 600 });
  assert.deepEqual(threeD.threeDCameraPatch(true, { maxPitch: 40 }), { pitch: 40, duration: 600 });
});

test('turning 3D off levels the pitch AND returns north in one tap', () => {
  assert.deepEqual(threeD.threeDCameraPatch(false, { maxPitch: 60 }), {
    pitch: 0,
    bearing: 0,
    duration: 600,
  });
});

test('reduced motion makes the camera patch instant', () => {
  assert.deepEqual(threeD.threeDCameraPatch(true, { maxPitch: 60, reducedMotion: true }), {
    pitch: 55,
    duration: 0,
  });
  assert.deepEqual(threeD.threeDCameraPatch(false, { maxPitch: 60, reducedMotion: true }), {
    pitch: 0,
    bearing: 0,
    duration: 0,
  });
});

test('the buildings detector reads the live style, not a claim', () => {
  assert.equal(
    threeD.styleHasBuildingExtrusions({
      layers: [
        { id: 'background', type: 'background' },
        { id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building' },
      ],
    }),
    true,
  );
  assert.equal(threeD.styleHasBuildingExtrusions({ layers: [{ id: 'building', type: 'fill' }] }), false);
  assert.equal(threeD.styleHasBuildingExtrusions({ layers: [] }), false);
  for (const style of [null, undefined, {}, { layers: 'nope' }]) {
    assert.equal(threeD.styleHasBuildingExtrusions(style), false, JSON.stringify(style));
  }
});

test('the terrain source builder shapes a raster-dem source with its licence line', () => {
  assert.deepEqual(
    terrainLayer.terrainSource({
      terrainUrl: 'https://tiles.example/terrarium/{z}/{x}/{y}.png',
      terrainAttribution: 'Mapzen, Mapbox, OpenStreetMap',
    }),
    {
      type: 'raster-dem',
      tiles: ['https://tiles.example/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      maxzoom: 15,
      tileSize: 256,
      attribution: 'Mapzen, Mapbox, OpenStreetMap',
    },
  );
});

test('the terrain source is refused without its attribution line', () => {
  assert.equal(terrainLayer.terrainSource({ terrainUrl: 'https://tiles.example/{z}/{x}/{y}.png', terrainAttribution: '' }), null);
  assert.equal(terrainLayer.terrainSource({ terrainAttribution: 'Mapzen' }), null);
  assert.equal(terrainLayer.terrainSource(null), null);
});

test('terrain counts as configured only with both pieces of evidence', () => {
  assert.equal(
    terrainLayer.terrainConfigured({
      threeD: { terrainUrl: 'https://tiles.example/{z}/{x}/{y}.png', terrainAttribution: 'Mapzen' },
    }),
    true,
  );
  assert.equal(terrainLayer.terrainConfigured({ threeD: { terrainUrl: 'https://tiles.example/{z}/{x}/{y}.png', terrainAttribution: ' ' } }), false);
  assert.equal(terrainLayer.terrainConfigured(null), false);
  assert.equal(terrainLayer.terrainConfigured({}), false);
});
