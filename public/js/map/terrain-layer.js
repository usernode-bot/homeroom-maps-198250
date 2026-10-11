// Terrain elevation source (Phase 12H) — the DEM source spec the renderer
// adds when an operator configures one.
//
// Terrain ships DISABLED: `MAP_3D_TERRAIN_URL` defaults to empty, so no
// source is ever created, no elevation is fetched and no Terrain control
// appears. Turning it on is an operator decision made in two pieces that must
// BOTH be present: the tile template and the attribution line the DEM data's
// licence requires. One without the other is refused here, in the config
// resolver and by the client's capability gate — the same fail-closed
// discipline as the offline download gate.
//
// The URL is a tile template (`{z}/{x}/{y}` raster-dem tiles, terrarium
// encoding), not a TileJSON endpoint: the default candidate source, AWS
// Mapzen Terrain Tiles, is served that way. `maxzoom` 15 and `tileSize` 256
// reflect that source's own documented limits; an operator pointing elsewhere
// inherits them as this phase's accepted limits.
'use strict';

export const TERRAIN_SOURCE_ID = 'hm-terrain';

// The raster-dem source spec for a configured terrain pair, or null when the
// pair is incomplete — a source without its attribution line is never built.
export function terrainSource(config) {
  const { terrainUrl, terrainAttribution } = config || {};
  const url = typeof terrainUrl === 'string' ? terrainUrl.trim() : '';
  const attribution =
    typeof terrainAttribution === 'string' ? terrainAttribution.trim() : '';
  if (!url || !attribution) return null;
  return {
    type: 'raster-dem',
    tiles: [url],
    encoding: 'terrarium',
    maxzoom: 15,
    tileSize: 256,
    attribution,
  };
}

// True when the config carries BOTH pieces of terrain evidence. Shared by the
// renderer (which decides whether a DEM source can exist at all) and the
// tests; the capability resolver re-checks the same rule.
export function terrainConfigured(mapConfig) {
  const threeD = mapConfig && mapConfig.threeD;
  return Boolean(
    threeD &&
      typeof threeD.terrainUrl === 'string' &&
      threeD.terrainUrl.trim() &&
      typeof threeD.terrainAttribution === 'string' &&
      threeD.terrainAttribution.trim(),
  );
}
