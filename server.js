const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const {
  IS_STAGING,
  PORT,
  PLATFORM_ORIGIN,
  JWT_PUBLIC_KEY,
  APP_AUDIENCE,
  PUBLIC_DIR,
  resolveMapConfig,
  COMMUNITY_REVIEWERS,
} = require('./config');
const searchApi = require('./search');
const { createPolicies } = require('./community/policies');
const { createStore } = require('./community/store');
const { createCommunityRouter } = require('./community/routes');
const { parseReviewers } = require('./community/model');
const { createReportsStore } = require('./reports/store');
const { createReportsRouter } = require('./reports/routes');
const placesApi = require('./places');
const { firstAcceptLanguage } = require('./search/normalize');
const routingApi = require('./routing');
const { createStore: createSavedStore } = require('./saved/store');
const { createSavedRouter } = require('./saved/routes');
const { createProfiles } = require('./saved/profiles');

const app = express();
const port = PORT;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Community core: proposals, votes and their status history. `policies` is
// the (deliberately empty) registry where moderation, spam, duplicate and
// reputation systems plug in later; see community/policies.js.
const communityPolicies = createPolicies();
const communityStore = createStore({
  pool,
  policies: communityPolicies,
  platformOrigin: PLATFORM_ORIGIN,
});

// Saved places (Phase 7): per-user lists and saved places in Postgres.
// Ownership is enforced in every query and by a composite owner foreign key;
// see saved/store.js. `profiles` reads the person's own proposals and votes
// out of the community tables — read-only, no Phase 5 logic touched.
const savedStore = createSavedStore({ pool });
const profiles = createProfiles({ pool });

// Community reports (Phase 6): the same policies registry is shared with the
// proposal store, so a moderation system plugged in there hears report
// events too (report.flagged and friends).
const reportsStore = createReportsStore({ pool, policies: communityPolicies });

// Lifecycle state. `server` is the listener captured so the shutdown handler
// can stop accepting connections; `shuttingDown` makes /health report draining
// and the shutdown handler idempotent.
let server = null;
let shuttingDown = false;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/config']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// PLATFORM_ORIGIN, JWT_PUBLIC_KEY and APP_AUDIENCE come from config.js.

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) =>
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'draining' : 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Public, non-sensitive configuration for the client. Returned by GET so the
// auth middleware does not require a token for it, but it carries no secret:
// only values safe to print in a browser. `mapProvider: null` is the explicit
// signal that no map provider is connected; the `map` block carries the public
// source details (style URLs, the exact attribution string) the client needs,
// all resolved from the environment by config.js. `searchProvider` mirrors
// it: the configured search adapter's name, or null while the active adapter
// is a placeholder. `routing` carries the Directions equivalent: which
// provider is connected, the travel modes it genuinely serves (the UI's
// travel-mode selector is driven by exactly this), and its capabilities.
// `placeProvider` is the same signal for per-place data (photos, hours,
// contact, rating): null until a place provider adapter ships. Nothing here
// reads dapp.json secrets, and the keyless defaults read no key at all.
app.get('/api/config', (_req, res) => {
  const { mapProvider, map } = resolveMapConfig();
  const routing = routingApi.resolveRoutingConfig();
  res.json({
    appName: 'Homeroom Maps',
    environment: IS_STAGING ? 'staging' : 'production',
    mapProvider,
    map,
    searchProvider: searchApi.activeProviderName(),
    routing,
    placeProvider: placesApi.activeProviderName(),
    features: {
      map: Boolean(map.configured),
      search: true,
      directions: Boolean(routing.configured),
      communityVoting: true,
      ai: false,
      traffic: false,
      offline: false,
    },
  });
});

// The signed-in person, from the verified platform token. Profile renders
// these; `locale` may be null (the platform sends no preference for most
// users). The shape matches the platform's req.user contract.
app.get('/api/me', (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    locale: req.user.locale || null,
  });
});

// Profile (Phase 7) — the signed-in person's own contributions, proposals
// and votes. Read-only, and scoped to the caller's own id, so it can only
// ever describe the person asking. Saved places live under /api/saved.
app.get('/api/profile', async (req, res, next) => {
  try {
    const userId = String(req.user.id);
    const [overview, savedPlaceIds] = await Promise.all([
      profiles.overview(userId),
      savedStore.savedPlaceIds(userId),
    ]);
    res.json({ ...overview, savedPlaces: { count: savedPlaceIds.length } });
  } catch (err) {
    next(err);
  }
});

// Search — the two read routes of the search service (search/index.js).
// Both are GET under /api/, so the auth gate above covers them; the provider
// key never leaves the server. The typed error codes from search/provider.js
// map to HTTP statuses here and use the app's standard JSON error shape, so
// the client's apiGet() turns them into typed ApiErrors for free.
const SEARCH_ERROR_STATUS = {
  invalid_query: 400,
  not_configured: 501,
  rate_limited: 429,
};

async function handleSearch(req, res, mode) {
  try {
    // Language resolution order per the spec: explicit query param, then the
    // signed-in user's platform locale (JWT claim), then Accept-Language,
    // then omit and let the provider default.
    const lang =
      req.query.lang ||
      (req.user && req.user.locale) ||
      firstAcceptLanguage(req.headers['accept-language']) ||
      null;
    const out = await searchApi.run(
      mode,
      {
        q: req.query.q,
        limit: req.query.limit,
        bbox: req.query.bbox,
        near: req.query.near,
        radius: req.query.radius,
        lang: req.query.lang,
      },
      { lang },
    );
    res.json(out);
  } catch (err) {
    const code = err && err.code ? err.code : 'provider_error';
    console.warn(`[search:${mode}] ${code}: ` + (err && err.message));
    res.status(SEARCH_ERROR_STATUS[code] || 502).json({
      error: { code, message: (err && err.message) || 'Search failed.' },
    });
  }
}

app.get('/api/search/suggest', (req, res) => handleSearch(req, res, 'suggest'));
app.get('/api/search', (req, res) => handleSearch(req, res, 'search'));

// Directions — the one read route of the routing service (routing/index.js).
// GET under /api/, so the auth gate above covers it; no provider key exists
// for the keyless default, and a commercial adapter's key would never leave
// the server. The typed error codes from routing/provider.js map to HTTP
// statuses here and use the app's standard JSON error shape, so the client's
// apiGet() turns them into typed ApiErrors for free. `no_route` is 404
// deliberately: "no route between these points" is a legitimate answer, not
// a failure.
const ROUTING_ERROR_STATUS = {
  invalid_request: 400,
  unsupported_mode: 400,
  no_route: 404,
  not_configured: 501,
  rate_limited: 429,
  timeout: 504,
};

app.get('/api/directions', async (req, res) => {
  try {
    const out = await routingApi.run({
      origin: req.query.origin,
      destination: req.query.destination,
      waypoints: req.query.waypoints,
      mode: req.query.mode,
    });
    res.json(out);
  } catch (err) {
    const code = err && err.code ? err.code : 'provider_error';
    console.warn(`[directions] ${code}: ` + (err && err.message));
    res.status(ROUTING_ERROR_STATUS[code] || 502).json({
      error: { code, message: (err && err.message) || 'Routing failed.' },
    });
  }
});

app.use(
  '/api/community',
  createCommunityRouter({ store: communityStore, reviewers: parseReviewers(COMMUNITY_REVIEWERS) }),
);

app.use(
  '/api/reports',
  createReportsRouter({ store: reportsStore, reviewers: parseReviewers(COMMUNITY_REVIEWERS) }),
);

// Places — the two read routes of the place service (places/index.js). Both
// are GET under /api/, so the auth gate above covers them; the provider key
// never leaves the server. The typed error codes from places/provider.js map
// to HTTP statuses here and use the app's standard JSON error shape, so the
// client's apiGet() turns them into typed ApiErrors for free. With no place
// provider adapter implemented yet, every call answers an honest 501
// (not_configured) rather than fabricated POI data.
const PLACES_ERROR_STATUS = {
  invalid_query: 400,
  not_found: 404,
  not_configured: 501,
  rate_limited: 429,
};

async function handlePlaces(req, res, handler) {
  try {
    // Language resolution order, same as search: explicit query param, then
    // the signed-in user's platform locale (JWT claim), then Accept-Language,
    // then omit and let the provider default.
    const lang =
      req.query.lang ||
      (req.user && req.user.locale) ||
      firstAcceptLanguage(req.headers['accept-language']) ||
      null;
    const out = await handler({
      lang,
      raw: req.query,
      user: req.user || null,
    });
    res.json(out);
  } catch (err) {
    const code = err && err.code ? err.code : 'provider_error';
    console.warn(`[places] ${code}: ` + (err && err.message));
    res.status(PLACES_ERROR_STATUS[code] || 502).json({
      error: { code, message: (err && err.message) || 'The place lookup failed.' },
    });
  }
}

app.get('/api/places', (req, res) =>
  handlePlaces(req, res, ({ lang, raw }) =>
    placesApi.getPlaces({
      q: raw.q,
      near: raw.near,
      radius: raw.radius,
      bbox: raw.bbox,
      limit: raw.limit,
      lang,
    })));
app.get('/api/places/:id', (req, res) =>
  handlePlaces(req, res, ({ lang }) => placesApi.getPlaceDetails(req.params.id, { lang })));

// Saved places (Phase 7) — the real router replacing the 501 stub this path
// used to answer. GET /api/saved and GET /api/profile are public reads only
// in the sense that they need no reviewer role; the auth gate above still
// requires a verified platform token for every one of them, and each query is
// scoped to that token's user.
app.use('/api/saved', createSavedRouter({ store: savedStore }));

app.use(express.static(PUBLIC_DIR));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
// A /api/* path that matched none of the routes above is a 404 in JSON, not
// the HTML shell. Registered before the catch-all so an unknown API call under
// the auth gate never receives index.html.
app.use('/api', (_req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: 'No such API route.' },
  });
});

// Centralized error handler. Returns the same JSON error shape as the rest of
// the API and never leaks a stack trace outside staging. Reached by any
// synchronous throw in a handler; wrap any future async handler so a
// rejected promise is forwarded here too.
app.use((err, _req, res, _next) => {
  console.error('[api error]', err && err.stack ? err.stack : err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side.',
      ...(IS_STAGING ? { detail: String((err && err.message) || err) } : {}),
    },
  });
});

app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/homeroom-maps-198250/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/homeroom-maps-198250/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

async function start() {
  // Idempotent boot migration: the community tables (all staging:private),
  // the Phase 7 saved-places tables, and the report tables (reports and
  // report_status_events public, the reaction and flag tables
  // staging:private). Place and map tables arrive with their features in
  // later stages. The starter template's `presses` table is intentionally
  // NOT created here (a database that already has it keeps it; nothing
  // drops it).
  await communityStore.migrate();
  await savedStore.migrate();
  if (IS_STAGING) await communityStore.seedStaging();
  await reportsStore.migrate();
  if (IS_STAGING) await reportsStore.seedStaging();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Graceful shutdown: on SIGTERM/SIGINT stop accepting connections, give
// in-flight requests a short drain window, close the Postgres pool and exit.
// The deadline is a literal constant (~3s), not an env var — the platform's
// stop grace is a ceiling, not an allowance to spend.
const DRAIN_MS = 3000;

async function shutdown(signal) {
  if (shuttingDown) return; // idempotent: a repeat signal during drain is a no-op
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e && e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
