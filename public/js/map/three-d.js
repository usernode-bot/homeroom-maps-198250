// 3D map capability — the pure gate every Phase 12H surface keys on.
//
// Three INDEPENDENT capability flags, each fail-closed by construction:
//
//   pitch     the 3D camera (a pitch move over tiles already loaded; no new
//             data source behind it)
//   buildings 3D building extrusions — NOT resolved here: the extrusion
//             layer lives in the externally hosted basemap style, which can
//             change without notice, so the flag is detected at runtime from
//             the live style (styleHasBuildingExtrusions) and never
//             advertised by server config
//   terrain   terrain elevation from an operator-configured DEM source; it
//             stays off unless BOTH a tile URL and an attribution line are
//             configured — the same evidence-first discipline the offline
//             downloads gate applies
//
// The output describes what the UI may render: an unavailable capability
// simply never gets a control, rather than a control that does nothing.
'use strict';

export const MAP_3D_STAGE = {
  READY: 'ready',
  DISABLED: 'disabled',
  NOT_CONFIGURED: 'not_configured',
};

// The pitch the camera eases to when 3D turns on, and the hard ceiling for
// any configured max pitch. 55° keeps touch panning predictable on a phone;
// 85° is MapLibre's own extreme and would pin the camera near-horizontal.
export const PITCH_ON = 55;
export const MAX_PITCH_LIMIT = 85;

// Clamp a configured max pitch into [0, 85]. A missing or malformed value
// falls back to the 60° default rather than disabling or unbounding the
// camera; only an explicit numeric 0 clamps to 0.
export function clampMaxPitch(value) {
  if (value == null || value === '') return 60;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(MAX_PITCH_LIMIT, Math.max(0, Math.round(parsed)));
}

// Clamp a single pitch request into [0, maxPitch] — maxPitch itself clamped.
export function clampPitch(value, maxPitch) {
  const max = clampMaxPitch(maxPitch);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(0, parsed));
}

// Resolve the effective 3D capability from the public config's `map` block
// (what /api/config prints). Dependency-injected config, node-testable; no
// browser globals. Fail closed: a missing, malformed or disabled block
// resolves with every flag false.
export function resolveThreeDCapabilities({ config } = {}) {
  const configured = Boolean(config && config.configured && config.styleUrl);
  const caps = (config && config.capabilities) || null;
  const threeD = (config && config.threeD) || null;

  const maxPitch = clampMaxPitch(threeD && threeD.maxPitch != null ? threeD.maxPitch : 60);
  const terrainUrl =
    threeD && typeof threeD.terrainUrl === 'string' ? threeD.terrainUrl.trim() : '';
  const terrainAttribution =
    threeD && typeof threeD.terrainAttribution === 'string' ? threeD.terrainAttribution.trim() : '';

  // The camera is renderer-native, so its only gates are the config switch
  // and the map actually being configured. An unconfigured map never
  // advertises 3D.
  const pitch = Boolean(caps && caps.pitch === true) && configured && maxPitch > 0;

  // Terrain needs the operator switch AND both of its pieces of evidence:
  // a tile URL and the attribution line the data's licence requires. The
  // server resolves the same rule; this re-check is the client-side backstop.
  const terrain =
    Boolean(caps && caps.terrain === true) &&
    configured &&
    Boolean(terrainUrl && terrainAttribution);

  return {
    stage:
      pitch || terrain
        ? MAP_3D_STAGE.READY
        : configured
          ? MAP_3D_STAGE.DISABLED
          : MAP_3D_STAGE.NOT_CONFIGURED,
    pitch,
    terrain,
    maxPitch,
    terrainUrl: terrain ? terrainUrl : null,
    terrainAttribution: terrain ? terrainAttribution : null,
  };
}

// The camera patch a 3D toggle applies, as a pure object so the renderer and
// the tests share one definition. Turning 3D on eases the pitch up (never
// beyond the configured max); turning it off levels the camera flat AND
// north-up, so recovery is one tap no matter how the camera got tilted.
export function threeDCameraPatch(enabled, { maxPitch = 60, reducedMotion = false } = {}) {
  const pitch = enabled ? Math.min(PITCH_ON, clampMaxPitch(maxPitch)) : 0;
  const patch = { pitch, duration: reducedMotion ? 0 : 600 };
  if (!enabled) patch.bearing = 0;
  return patch;
}

// True when the basemap style actually carries a 3D building-extrusion
// layer. Evaluated against the LIVE style every time it loads or swaps, so
// the flag tracks reality instead of a claim: if the provider ever drops the
// layer, the app stops claiming buildings rather than promising them.
export function styleHasBuildingExtrusions(style) {
  const layers = style && Array.isArray(style.layers) ? style.layers : null;
  if (!layers) return false;
  return layers.some((layer) => layer && layer.type === 'fill-extrusion');
}
