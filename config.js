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

module.exports = {
  IS_STAGING,
  PORT,
  PLATFORM_ORIGIN,
  JWT_PUBLIC_KEY,
  APP_AUDIENCE,
  PUBLIC_DIR,
};
