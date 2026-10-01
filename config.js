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
        },
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
      },
      ...(token ? { token } : {}),
    },
  };
}

module.exports = {
  IS_STAGING,
  PORT,
  PLATFORM_ORIGIN,
  JWT_PUBLIC_KEY,
  APP_AUDIENCE,
  PUBLIC_DIR,
  MAP_PROVIDER,
  resolveMapConfig,
};
