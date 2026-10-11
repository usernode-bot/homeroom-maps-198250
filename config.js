// Server-side environment configuration for Homeroom Maps.
//
// Centralises every value read from the process environment so the rest of
// the server imports it instead of recomputing it inline. Nothing here is
// secret material: this module exposes only what the platform injects.
//
// Reserved variables the platform provides at runtime (never declared in
// dapp.json): DATABASE_URL, USERNODE_JWT_PUBLIC_KEY, USERNODE_APP_ID, PORT,
// USERNODE_ENV. USERNODE_PLATFORM_ORIGIN names this app's platform host and
// is set by the runtime; it is unset for a plain local `node server.js`.

'use strict';

const path = require('path');

// `USERNODE_ENV` is `staging` or `production`. It gates DATA and irreversible
// outbound side effects only, never which features exist or how logic runs.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PORT = Number(process.env.PORT) || 3000;

// The platform host, at runtime, only from the variable the platform
// injects. No hostname is written into the source: a baked-in one is what
// breaks every app at once when the platform's domain moves.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

// The platform's RSA PUBLIC key (PEM). Containers hold only the public half,
// so this app can verify a user's identity but cannot mint one.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted per app: the audience names this app's numeric id, so a
// token issued for a different app is rejected.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

const PUBLIC_DIR = path.join(__dirname, 'public');

// ── Map configuration ─────────────────────────────────────────────────────
// The map's data source is configuration, never code. A keyless default keeps
// this phase free of keys and tokens: a host changes the source by setting the
// environment (MAP_PROVIDER, MAP_STYLE_URL), and a future keyed provider is a
// new preset here plus a dapp.json entry, not a source edit.
const MAP_PROVIDER = process.env.MAP_PROVIDER || 'maplibre-openfreemap';

// The attribution shown for any source whose own required string is not yet
// written: OpenStreetMap data underlies every candidate source, so naming it
// alone is the truthful minimum.
const BASELINE_ATTRIBUTION = 'OpenStreetMap';

// Provider name -> the public map configuration it resolves to. `provider` is
// the adapter key the client registry uses; everything else is what GET
// /api/config prints. Only values safe to print in a browser belong here.
const MAP_PROVIDER_PRESETS = {
  'maplibre-openfreemap': {
    provider: 'maplibre',
    label: 'OpenFreeMap',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    styleUrlDark: null,
    attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
    requiresKey: false,
  },
};

// Resolve the public map block. When MAP_PROVIDER names no known preset the
// map is not configured: `mapProvider` is null and nothing but the baseline
// attribution is advertised, so the client renders the not-configured frame
// instead of a broken map.
function resolveMapConfig() {
  const preset = MAP_PROVIDER_PRESETS[MAP_PROVIDER];
  if (!preset) {
    return {
      mapProvider: null,
      map: {
        configured: false,
        provider: null,
        label: null,
        styleUrl: null,
        styleUrlDark: null,
        attribution: BASELINE_ATTRIBUTION,
        requiresKey: false,
        capabilities: {
          rotation: false,
          touchGestures: false,
          accuracyCircle: false,
          offline: false,
          traffic: false,
          geocoding: false,
          routing: false,
          // 3D (Phase 12H): an unconfigured map never advertises 3D.
          pitch: false,
          buildings: false,
          terrain: false,
        },
        threeD: resolveThreeDConfig(),
      },
    };
  }
  // A browser map key is only read when the selected provider needs one; the
  // keyless default reads nothing. A keyed provider's key is a browser-visible
  // value served through /api/config like any other public value, never a
  // server-only secret exposed to the page.
  const token = preset.requiresKey ? process.env.MAP_TILE_TOKEN || '' : null;
  return {
    mapProvider: MAP_PROVIDER,
    map: {
      configured: true,
      provider: preset.provider,
      label: preset.label,
      styleUrl: process.env.MAP_STYLE_URL || preset.styleUrl,
      styleUrlDark: process.env.MAP_STYLE_URL_DARK || preset.styleUrlDark || null,
      attribution: preset.attribution,
      requiresKey: preset.requiresKey,
      // Only the capability flags, never the key itself, decide which
      // controls appear client-side.
      capabilities: {
        rotation: true,
        touchGestures: true,
        accuracyCircle: true,
        offline: false,
        traffic: false,
        geocoding: false,
        routing: false,
        // 3D (Phase 12H). The camera rides on the configured map itself, so
        // its only switch is MAP_3D_ENABLED. Terrain additionally requires
        // BOTH its evidence pieces; the client resolver re-checks the same
        // rule as a backstop. Buildings stay unadvertised (runtime-detected).
        pitch: MAP_3D_ENABLED,
        buildings: false,
        terrain: Boolean(MAP_3D_TERRAIN_URL && MAP_TERRAIN_ATTRIBUTION),
      },
      threeD: resolveThreeDConfig(),
      ...(token ? { token } : {}),
    },
  };
}

// ── 3D map (Phase 12H) ────────────────────────────────────────────────────
// The 3D camera and its two optional data capabilities, as independent
// operator switches. The camera (pitch/bearing) needs no new data source, so
// it is on with the map itself; terrain needs an operator-supplied DEM tile
// URL AND the attribution line its data licence requires, and stays off while
// either piece is missing — fail closed, the same discipline as the offline
// B2 gate. Buildings are never advertised here: their extrusion layer lives
// in the hosted basemap style and is detected client-side from the live style
// instead of claimed by configuration.
const MAP_3D_ENABLED = !/^(false|0|no|off)$/i.test(
  String(process.env.MAP_3D_ENABLED || 'true').trim(),
);
const MAP_3D_MAX_PITCH = clampMaxPitch(process.env.MAP_3D_MAX_PITCH || '60');
const MAP_3D_TERRAIN_URL = (process.env.MAP_3D_TERRAIN_URL || '').trim();
const MAP_TERRAIN_ATTRIBUTION = (process.env.MAP_TERRAIN_ATTRIBUTION || '').trim();

// Clamp the configured max camera pitch into [0, 85]. A missing or malformed
// value falls back to MapLibre's own 60° default rather than unbounding the
// camera; only an explicit numeric 0 clamps to 0.
function clampMaxPitch(value) {
  if (value == null || value === '') return 60;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(85, Math.max(0, Math.round(parsed)));
}

// The public `map.threeD` block: what the client's 3D resolver reads. The raw
// terrain pieces are printed even when incomplete so the client-side
// re-check sees the same inputs the server did.
function resolveThreeDConfig() {
  return {
    maxPitch: MAP_3D_MAX_PITCH,
    terrainUrl: MAP_3D_TERRAIN_URL,
    terrainAttribution: MAP_TERRAIN_ATTRIBUTION,
  };
}

// ── Offline maps (Phase 12A) ──────────────────────────────────────────────
// The operator kill-switch and the device budget for offline map areas.
// NEITHER value can enable bulk tile downloading: the effective capability
// still requires the tile-provider permission gate (offline/provider-policy.js,
// blocker B2), which is closed for every provider the repository has not
// documented. These two knobs only ever narrow what the permission gate
// already allows, so flipping them cannot bypass B2.
const OFFLINE_ENABLED = !/^(false|0|no|off)$/i.test(String(process.env.OFFLINE_ENABLED || 'true').trim());
const OFFLINE_MAX_STORAGE_MB = Math.max(
  0,
  Number.parseInt(process.env.OFFLINE_MAX_STORAGE_MB || '2048', 10) || 0,
) || 2048;

// The offline SEARCH operator switch (Phase 12B). Searching regions a device
// has already downloaded is a device-local read with no provider traffic, so
// it is independent of the B2 download gate: it may be on while downloads are
// off. Default true; the switch can only turn offline search off, never
// invent an index or a network call.
const OFFLINE_SEARCH_ENABLED = !/^(false|0|no|off)$/i.test(
  String(process.env.OFFLINE_SEARCH_ENABLED || 'true').trim(),
);

// ── Live traffic (Phase 12D) ──────────────────────────────────────────────
// The operator switch for the live traffic layer. It can only narrow the
// live-traffic permission gate (traffic/provider-policy.js, blocker T1),
// never widen it: while the repository documents no traffic-provider rights
// (docs/traffic-provider-rights.md does not exist) and no traffic adapter is
// implemented, flipping this cannot produce a traffic layer. The provider's
// API key, when one is ever chosen, gets declared in dapp.json by the change
// that implements its adapter — never here.
const TRAFFIC_ENABLED = !/^(false|0|no|off)$/i.test(String(process.env.TRAFFIC_ENABLED || 'true').trim());

// Search provider configuration. `SEARCH_PROVIDER` names the adapter the
// search service uses (see search/providers/); it defaults to Photon, which
// needs no key and no billing, so the app works out of the box and staging
// and production run the identical code path. `PHOTON_URL` and `PELIAS_URL`
// let a self-hosted instance replace the public endpoints without a code
// change. Both are declared in dapp.json (required: false) with these same
// defaults; the API-key secrets for the commercial adapters are deliberately
// NOT declared here — each gets declared in the same change that implements
// its adapter, per the platform secrets convention.
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'photon')
  .trim()
  .toLowerCase();
const PHOTON_URL = (process.env.PHOTON_URL || 'https://photon.komoot.io')
  .trim()
  .replace(/\/+$/, '');
const PELIAS_URL = (process.env.PELIAS_URL || '').trim().replace(/\/+$/, '');
const PELIAS_API_KEY = (process.env.PELIAS_API_KEY || '').trim();

// ── Routing configuration ─────────────────────────────────────────────────
// Same posture as the search stack: the active routing provider is
// configuration, never code, and the keyless default (OSRM's public demo
// server, car profile) keeps the app working with no secret at all. An API
// key for a commercial provider gets declared in dapp.json by the change
// that implements its adapter.
const ROUTING_PROVIDER = (process.env.ROUTING_PROVIDER || 'osrm')
  .trim()
  .toLowerCase();
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org')
  .trim()
  .replace(/\/+$/, '');

// An OSRM server serves the profiles it was built with, and the public demo
// server is car-only. OSRM_PROFILES maps the app's travel modes onto OSRM
// profile names ("driving:driving,walking:foot,cycling:bike"); a mode that
// is absent means the configured endpoint does not serve it, so it is
// REFUSED (unsupported_mode) rather than pretended. A self-hosted
// multi-profile deployment enables walking and cycling purely through this
// setting.
const OSRM_PROFILES = parseOsrmProfiles(process.env.OSRM_PROFILES || 'driving:driving');

function parseOsrmProfiles(raw) {
  const profiles = {};
  for (const pair of String(raw).split(',')) {
    const [mode, profile] = pair.split(':').map((s) => s && s.trim());
    if (!mode || !profile) continue;
    profiles[mode] = profile;
  }
  return profiles;
}

// Community reviewers: comma-separated platform usernames allowed to move
// proposals through review (Under Review, Accepted, Rejected, Implemented).
// Declared in dapp.json (required: false). Unset means nobody can review yet,
// in staging and production alike; the role is never granted by environment.
const COMMUNITY_REVIEWERS = process.env.COMMUNITY_REVIEWERS || '';

// Place-data provider configuration (Phase 3, Places).
//
// PLACE_PROVIDER names the adapter the place service (places/) uses for
// per-place depth: photos, opening hours, phone, website, rating, business
// status. There is deliberately NO default: no adapter is implemented yet, so
// leaving this unset keeps /api/places answering an honest 501 rather than
// serving fabricated POI data. Selection criteria for the eventual provider,
// in order (the same list lives in the dapp.json PLACE_PROVIDER description):
//   1. worldwide coverage of the place types the app surfaces,
//   2. per-place detail depth: photos, opening hours, phone, website, rating,
//   3. licensing that permits storing and displaying results,
//   4. cost at this app's scale,
//   5. the required credential declarable through the platform Secrets UI.
// Per the platform secrets convention, the chosen provider's API key is
// declared in dapp.json in the same change that implements its adapter —
// never hardcoded here. Like SEARCH_PROVIDER, the value is lower-cased.
const PLACE_PROVIDER = (process.env.PLACE_PROVIDER || '')
  .trim()
  .toLowerCase();

// Weather provider configuration (Phase 12G).
//
// WEATHER_PROVIDER names the adapter the weather service (weather/) uses for
// current conditions at the map centre. There is deliberately NO default: no
// adapter is implemented yet and no weather source is documented as
// authorized for this repository, so leaving this unset keeps
// /api/weather/current answering an honest 501 rather than serving
// fabricated weather. Unlike SEARCH_PROVIDER and PLACE_PROVIDER, a name
// alone is not enough: the W1 permission gate
// (weather/provider-policy.js) additionally requires
// docs/weather-provider-rights.md to authorize the provider for live data
// with named evidence. Selection criteria for the eventual provider, in
// order (the same list lives in the dapp.json WEATHER_PROVIDER description):
//   1. licensing that permits live use and display with attribution,
//   2. worldwide point-forecast coverage at the precision the panel shows,
//   3. cost at this app's scale (a cached, per-point read is tiny),
//   4. the required credential declarable through the platform Secrets UI,
//   5. an answer shape an adapter can normalize without guessing.
// Per the platform secrets convention, the chosen provider's API key is
// declared in dapp.json in the same change that implements its adapter —
// never hardcoded here. Like SEARCH_PROVIDER, the value is lower-cased.
const WEATHER_PROVIDER = (process.env.WEATHER_PROVIDER || '')
  .trim()
  .toLowerCase();

// ── AI assistant (Phase 11) ───────────────────────────────────────────────
// The ONLY AI path is the platform's LLM proxy. Neither value below is a
// third-party key: the platform injects both in production and injects
// NEITHER in staging (unreviewed code must not be able to spend a user's
// budget) or in a standalone deploy. The app is enabled only when BOTH are
// present, which is deliberately stricter than the platform's minimal
// example: a URL alone or a token alone is a misconfiguration, and the safe
// direction is the honest unavailable state rather than a network error.
// Neither value is declared in dapp.json; both are platform-injected.
const LLM_PROXY_URL = (process.env.USERNODE_LLM_PROXY_URL || '').trim().replace(/\/+$/, '');
const LLM_PROXY_TOKEN = (process.env.USERNODE_LLM_PROXY_TOKEN || '').trim();
const LLM_ENABLED = Boolean(LLM_PROXY_URL && LLM_PROXY_TOKEN);

module.exports = {
  IS_STAGING,
  PORT,
  PLATFORM_ORIGIN,
  JWT_PUBLIC_KEY,
  APP_AUDIENCE,
  PUBLIC_DIR,
  MAP_PROVIDER,
  MAP_3D_ENABLED,
  MAP_3D_MAX_PITCH,
  MAP_3D_TERRAIN_URL,
  MAP_TERRAIN_ATTRIBUTION,
  resolveMapConfig,
  OFFLINE_ENABLED,
  OFFLINE_MAX_STORAGE_MB,
  OFFLINE_SEARCH_ENABLED,
  TRAFFIC_ENABLED,
  SEARCH_PROVIDER,
  PHOTON_URL,
  PELIAS_URL,
  PELIAS_API_KEY,
  ROUTING_PROVIDER,
  OSRM_URL,
  OSRM_PROFILES,
  COMMUNITY_REVIEWERS,
  PLACE_PROVIDER,
  WEATHER_PROVIDER,
  LLM_PROXY_URL,
  LLM_PROXY_TOKEN,
  LLM_ENABLED,
};
