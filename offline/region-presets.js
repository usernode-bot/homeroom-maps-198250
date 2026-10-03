// Rectangular region presets for offline map areas (Phase 12A).
//
// Phase 12A deliberately ships server-defined rectangular presets, not
// administrative-boundary downloads. Each preset is a bounds rectangle, a
// zoom range and a size estimate, all resolved server-side so the client
// never invents geometry. A preset is only ever offered to a person after
// the provider-permission gate (see provider-policy.js) has permitted
// downloads for the configured source; with the gate closed the catalog is
// not advertised at all.
//
// The estimates use the same tile-count math the download planner uses
// (region-manifest.js tileCountForBounds) times a per-tile byte assumption
// for Mapbox Vector Tiles. It is an estimate for the picker's size review —
// the real byte count comes from what was actually stored and verified.
'use strict';

const { tileCountForBounds } = require('./region-manifest');

// Assumed average compressed vector tile size, bytes. Used only for the
// picker's estimate; the manifest's real byteSize is measured after download.
const AVG_TILE_BYTES = 30 * 1024;

const REGION_PRESETS = [
  {
    id: 'jakarta',
    name: 'Jakarta',
    bounds: { west: 106.63, south: -6.42, east: 107.02, north: -6.03 },
    zoom: { min: 10, max: 14 },
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    format: 'mvt',
  },
  {
    id: 'bandung',
    name: 'Bandung',
    bounds: { west: 107.5, south: -7.05, east: 107.72, north: -6.83 },
    zoom: { min: 10, max: 14 },
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    format: 'mvt',
  },
  {
    id: 'yogyakarta',
    name: 'Yogyakarta',
    bounds: { west: 110.28, south: -7.85, east: 110.48, north: -7.68 },
    zoom: { min: 10, max: 14 },
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    format: 'mvt',
  },
  {
    id: 'surabaya',
    name: 'Surabaya',
    bounds: { west: 112.63, south: -7.36, east: 112.85, north: -7.16 },
    zoom: { min: 10, max: 14 },
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    format: 'mvt',
  },
  {
    id: 'bali-south',
    name: 'South Bali',
    bounds: { west: 114.95, south: -8.85, east: 115.32, north: -8.6 },
    zoom: { min: 10, max: 14 },
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    format: 'mvt',
  },
  {
    id: 'singapore',
    name: 'Singapore',
    bounds: { west: 103.6, south: 1.16, east: 104.05, north: 1.48 },
    zoom: { min: 10, max: 14 },
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    format: 'mvt',
  },
];

// Estimated download size of a preset, in bytes. tileSize lets the preset
// catalog adapt to a raster source without changing the math.
function estimateRegionSize(preset, tileSize = AVG_TILE_BYTES) {
  let tiles = 0;
  for (let z = preset.zoom.min; z <= preset.zoom.max; z += 1) {
    tiles += tileCountForBounds(preset.bounds, z);
  }
  return tiles * tileSize;
}

// The catalog as it is served to a client that may download. Each preset
// carries its resolved tile count and estimated size so the picker never
// computes geometry itself.
function presentPresets() {
  return REGION_PRESETS.map((preset) => ({
    ...preset,
    tileCount: countPresetTiles(preset),
    estimatedBytes: estimateRegionSize(preset),
  }));
}

function countPresetTiles(preset) {
  let tiles = 0;
  for (let z = preset.zoom.min; z <= preset.zoom.max; z += 1) {
    tiles += tileCountForBounds(preset.bounds, z);
  }
  return tiles;
}

module.exports = {
  REGION_PRESETS,
  AVG_TILE_BYTES,
  estimateRegionSize,
  countPresetTiles,
  presentPresets,
};