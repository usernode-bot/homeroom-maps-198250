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

module.exports = {
  IS_STAGING,
  PORT,
  PLATFORM_ORIGIN,
  JWT_PUBLIC_KEY,
  APP_AUDIENCE,
  PUBLIC_DIR,
  SEARCH_PROVIDER,
  PHOTON_URL,
  PELIAS_URL,
  PELIAS_API_KEY,
  PLACE_PROVIDER,
};
