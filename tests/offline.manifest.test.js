// The RegionManifest v1 contract, the B2 provider-permission gate and the
// preset catalog (Phase 12A). The manifest contract is frozen: a region's
// shape may only grow through a new version, so these tests pin the fields,
// the artifact kinds and the tile math the download planner and the presets
// estimator share.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  MANIFEST_VERSION,
  ARTIFACT_KINDS,
  REGION_STATUSES,
  validateRegionManifest,
  longitudeToTileX,
  latitudeToTileY,
  tileCountForBounds,
} = require('../offline/region-manifest');
const { resolveProviderRights, RIGHTS_DOC_PATH } = require('../offline/provider-policy');
const { REGION_PRESETS, presentPresets, countPresetTiles } = require('../offline/region-presets');
const { resolveOfflineConfig } = require('../offline');

function validManifest(overrides = {}) {
  return {
    version: 1,
    id: 'region-1',
    name: 'Jakarta',
    provider: 'maplibre-openfreemap',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    bounds: { west: 106.63, south: -6.42, east: 107.02, north: -6.03 },
    zoom: { min: 10, max: 14 },
    artifacts: [{ kind: 'tiles', format: 'mvt', status: 'pending' }],
    status: 'downloading',
    createdAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

test('manifest version is frozen at 1 and artifact kinds are the contract kinds', () => {
  assert.equal(MANIFEST_VERSION, 1);
  assert.deepEqual(ARTIFACT_KINDS, ['tiles', 'index', 'graph']);
  assert.deepEqual(REGION_STATUSES, ['downloading', 'complete', 'interrupted', 'failed']);
});

test('a well-formed manifest validates and round-trips its fields', () => {
  const result = validateRegionManifest(validManifest());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, 'region-1');
  assert.equal(result.manifest.status, 'downloading');
  assert.equal(result.manifest.artifacts[0].kind, 'tiles');
});

test('validation never throws, whatever it is handed', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}]) {
    const result = validateRegionManifest(bad);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length);
  }
});

test('each contract violation is reported, not silently repaired', () => {
  const cases = [
    [validManifest({ version: 2 }), /version must be 1/],
    [validManifest({ id: 'bad id!' }), /id must be/],
    [validManifest({ name: '' }), /name must be/],
    [validManifest({ styleUrl: 'http://insecure.example/styles/x' }), /styleUrl must be an https URL/],
    [validManifest({ attribution: '' }), /attribution must be/],
    [validManifest({ artifacts: [] }), /artifacts must be a non-empty array/],
    [
      validManifest({ artifacts: [{ kind: 'index', format: 'mvt', status: 'pending' }] }),
      /at least one "tiles" artifact/,
    ],
    [validManifest({ status: 'finished' }), /status must be one of/],
  ];
  for (const [manifest, pattern] of cases) {
    const result = validateRegionManifest(manifest);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' | '), pattern);
  }
});

test('tile math agrees with the slippy-map definition', () => {
  assert.equal(longitudeToTileX(0, 0), 0);
  assert.equal(longitudeToTileX(0, 4), 8);
  // The Web Mercator latitude limit collapses to the first tile row.
  assert.equal(latitudeToTileY(85.05112878, 0), 0);
  assert.equal(latitudeToTileY(0, 4), 8);
});

test('tileCountForBounds counts the covering rectangle at one zoom', () => {
  // The whole world at zoom 0 is one tile.
  assert.equal(tileCountForBounds({ west: -180, south: -85, east: 180, north: 85 }, 0), 1);
  // Two adjacent tiles at zoom 1: the western half of the equator row.
  assert.equal(
    tileCountForBounds({ west: -180, south: 0, east: 0, north: 0 }, 1),
    2,
  );
  const jakarta = REGION_PRESETS.find((p) => p.id === 'jakarta');
  const count = tileCountForBounds(jakarta.bounds, 12);
  assert.ok(count > 0);
  // Recomputed from raw slippy math: (xMax-xMin+1) * (yMax-yMin+1).
  const xMin = longitudeToTileX(jakarta.bounds.west, 12);
  const xMax = longitudeToTileX(jakarta.bounds.east, 12);
  const yMin = latitudeToTileY(jakarta.bounds.north, 12);
  const yMax = latitudeToTileY(jakarta.bounds.south, 12);
  assert.equal(count, (xMax - xMin + 1) * (yMax - yMin + 1));
});

// ---- the B2 gate ----

test('the provider gate is closed for the configured provider as the repo stands', () => {
  const rights = resolveProviderRights('maplibre-openfreemap');
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'B2');
  assert.equal(rights.evidence, null);
});

test('the unlock document does not exist yet (honest B2 state)', () => {
  // If this assertion fails because docs/tile-provider-rights.md was added,
  // that is the deliberate unlock: update this test in the same change that
  // documents the rights, and never by editing the gate.
  assert.equal(fs.existsSync(RIGHTS_DOC_PATH), false);
});

test('a missing or unreadable document blocks downloads', () => {
  const rights = resolveProviderRights('any-provider', { docPath: '/nonexistent/doc.md' });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'B2');
});

test('all three markers are required to unlock', () => {
  const read = (doc) => (path) => (path === RIGHTS_DOC_PATH ? doc : undefined);

  const missingPermission = read('provider: maplibre-openfreemap\nevidence: https://example.com/terms\n');
  assert.equal(resolveProviderRights('maplibre-openfreemap', { readFileSync: missingPermission }).permitted, false);

  const missingEvidence = read('provider: maplibre-openfreemap\nbulk-download: permitted\n');
  assert.equal(resolveProviderRights('maplibre-openfreemap', { readFileSync: missingEvidence }).permitted, false);

  const wrongProvider = read('provider: some-other-provider\nbulk-download: permitted\nevidence: https://example.com\n');
  assert.equal(resolveProviderRights('maplibre-openfreemap', { readFileSync: wrongProvider }).permitted, false);

  const complete = read(
    'provider: maplibre-openfreemap\nbulk-download: permitted\nevidence: https://example.com/terms\n',
  );
  const unlocked = resolveProviderRights('maplibre-openfreemap', { readFileSync: complete });
  assert.equal(unlocked.permitted, true);
  assert.equal(unlocked.evidence, 'https://example.com/terms');
  assert.equal(unlocked.blocker, null);
});

test('a provider that is not configured blocks with a clear reason', () => {
  const rights = resolveProviderRights('');
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'B2');
});

// ---- presets ----

test('every preset carries bounds, a bounded zoom range and attribution', () => {
  assert.ok(REGION_PRESETS.length >= 5, 'the catalog offers several regions');
  for (const preset of REGION_PRESETS) {
    assert.ok(preset.id && preset.name);
    for (const key of ['west', 'south', 'east', 'north']) {
      assert.ok(Number.isFinite(preset.bounds[key]), `${preset.id}.${key}`);
    }
    assert.ok(preset.bounds.west < preset.bounds.east);
    assert.ok(preset.bounds.south < preset.bounds.north);
    assert.ok(preset.zoom.min >= 0 && preset.zoom.max <= 22 && preset.zoom.min <= preset.zoom.max);
    assert.ok(preset.attribution.includes('OpenStreetMap'));
  }
});

test('presentPresets attaches a real tile count and a byte estimate', () => {
  const presented = presentPresets();
  for (const preset of presented) {
    assert.equal(preset.tileCount, countPresetTiles(REGION_PRESETS.find((p) => p.id === preset.id)));
    assert.ok(preset.tileCount > 0);
    assert.ok(preset.estimatedBytes > 0);
  }
});

// ---- the effective capability ----

test('resolveOfflineConfig reports the honest blocked state for this repository', () => {
  const config = resolveOfflineConfig();
  assert.equal(config.offline, false);
  assert.equal(config.downloads.enabled, false);
  assert.equal(config.downloads.blocker, 'B2');
  assert.ok(config.downloads.reason);
  // With the gate closed the preset catalog is withheld entirely: a blocked
  // client cannot even render a download affordance.
  assert.deepEqual(config.presets, []);
  assert.ok(config.maxStorageBytes > 0);
});