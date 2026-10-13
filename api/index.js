// The /api/v1 developer API (Phase 12K): a read-only, key-authenticated
// adapter over the app's existing domain services.
//
// This module adds one credential type (API keys), one per-key limiter and
// allowlist projections. It calls the SAME exported service functions the
// app's own routes call and adds no query and no write of its own, so
// behaviour parity with the internal routes is structural. Deferred
// capabilities are reported, never advertised: there is no business-profile,
// traffic, transit or weather route here because those phases have not
// merged — no contract, no stub, no fabrication.
//
// Two credential kinds reach this router, and they never overlap:
//   • a bearer API key (Authorization: Bearer hm_live_…) for the public
//     read surface — every read endpoint requires it, there are no public
//     v1 paths;
//   • the platform JWT (x-usernode-token) for the key-management surface the
//     app's own Developer API screen uses (/keys). That surface is the app's
//     own plumbing, JWT-gated like every internal route, and is not part of
//     the public API document.
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { PUBLIC_STATUSES } = require('../community/model');
const { SCOPES } = require('./keys');
const {
  v1Error,
  sendV1Error,
  createKeyBuckets,
  createKeyAuth,
  requireScope,
  rateLimit,
  requireSession,
} = require('./middleware');
const {
  attributionFor,
  projectSearchResponse,
  projectRoutingResponse,
  projectPlacesResponse,
  projectPlaceResponse,
  projectProposal,
  projectProposalFeed,
  projectReport,
  projectReportFeed,
} = require('./projectors');

// The v1 page ceiling. The stores accept up to 50 (community pageMax); the
// public API binds tighter so a key can never page deeper than the app's own
// search surface does (search/normalize.js MAX_LIMIT is 20 too).
const MAX_PAGE_LIMIT = 20;
const DEFAULT_PAGE_LIMIT = 20;

// Typed service codes -> HTTP status, reusing the maps beside the internal
// routes (server.js SEARCH_ERROR_STATUS / ROUTING_ERROR_STATUS /
// PLACES_ERROR_STATUS). Anything not in the map reaches the fallback: an
// unexpected failure answers provider_error 502, never a stack trace.
const ERROR_STATUS = {
  invalid_query: 400,
  invalid_request: 400,
  unsupported_mode: 400,
  not_found: 404,
  no_route: 404,
  not_configured: 501,
  rate_limited: 429,
  timeout: 504,
};

// Parse a page limit the way v1 documents it: integer, floored at 1, ceiling
// MAX_PAGE_LIMIT, default otherwise — a stray value never breaks the feed.
function parseLimit(raw, fallback = DEFAULT_PAGE_LIMIT) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, MAX_PAGE_LIMIT);
}

function parseOffset(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

// The v1 read-only viewer for the community/report stores: the key owner,
// deliberately without reviewer status — v1 exposes the public surface, and
// reviewer powers are lifecycle writes that no v1 route can reach.
function apiViewer(key) {
  return {
    id: String(key.user_id),
    username: key.username,
    reviewer: false,
  };
}

function createApiV1({
  keys,
  searchApi,
  routingApi,
  placesApi,
  communityStore,
  reportsStore,
  verifySession,
  settings,
}) {
  const {
    enabled = true,
    rateLimitPerMinute = 60,
    directionsCost = 3,
    maxKeysPerUser = 5,
    openapiPath = null,
    log = (line) => console.log(line),
  } = settings || {};

  const router = express.Router();
  const buckets = createKeyBuckets({ perMinute: rateLimitPerMinute });
  const keyAuth = createKeyAuth({ keys });

  // One request id per request, echoed in the response, and one structured
  // completion line per request. The key is identifiable by its logged
  // PREFIX only; the auth middleware redacts the Authorization header before
  // any handler runs, so nothing downstream can log or forward the key.
  router.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.v1RequestId =
      typeof incoming === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(incoming)
        ? incoming
        : crypto.randomUUID();
    res.set('x-request-id', req.v1RequestId);
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // A bearer request whose key was refused carries kind 'key' with no
      // verified row; it logs as unverified, never crashes the response.
      const who =
        req.v1 && req.v1.kind === 'key'
          ? 'key=' + (req.v1.key ? req.v1.key.key_prefix : 'unverified')
          : req.v1 && req.v1.kind === 'session'
            ? 'key=session'
            : 'key=anonymous';
      log(
        `[api-v1] ${req.method} ${req.originalUrl} ${res.statusCode} ` +
          `${durationMs.toFixed(0)}ms ${who} req=${req.v1RequestId}`,
      );
    });
    next();
  });

  // The operator kill switch. API_ENABLED=0 turns the whole mount (read and
  // management alike) into 503 api_disabled, no redeploy needed.
  router.use((_req, res, next) => {
    if (!enabled) {
      return sendV1Error(
        res,
        v1Error('api_disabled', 'The API is disabled right now.', { status: 503 }),
      );
    }
    return next();
  });

  // Credential resolution: bearer key, platform session, or neither. Nothing
  // is enforced here; each route group enforces its own credential kind. A
  // bearer request is provisionally kind 'key' (keyAuth verifies it on the
  // read surface), which is what makes /keys answer 404 for an API key
  // instead of the management surface's own 401.
  router.use((req, _res, next) => {
    req.v1 = { kind: 'none' };
    if (req.headers.authorization) {
      req.v1 = { kind: 'key' };
      return next(); // keyAuth owns bearer requests
    }
    const user = verifySession ? verifySession(req) : null;
    if (user) req.v1 = { kind: 'session', user };
    return next();
  });

  // The key-management surface (the app's own screen), mounted at /keys and
  // JWT-gated. Bodies are parsed here too so the router is self-contained
  // under test; in the app the global parser has already run and this is a
  // no-op. An API key hitting these paths is refused by requireSession (404):
  // the public credential can never touch key lifecycle.
  const manageRouter = express.Router();
  manageRouter.use(express.json());
  manageRouter.use(requireSession());
  manageRouter.get('/', async (req, res, next) => {
    try {
      // The screen needs the service facts too (rate limit, key cost), so
      // they ride along with the key list rather than a second request.
      res.json({
        keys: await keys.list(req.v1.user),
        service: { rateLimitPerMinute, directionsCost, maxKeysPerUser },
      });
    } catch (err) {
      next(err);
    }
  });
  manageRouter.post('/', async (req, res, next) => {
    try {
      const created = await keys.create({ user: req.v1.user, name: req.body && req.body.name });
      res.status(201).json(created); // { key, record } — the key, shown once
    } catch (err) {
      next(err);
    }
  });
  manageRouter.delete('/:id', async (req, res, next) => {
    try {
      res.json(await keys.revoke(req.v1.user, req.params.id));
    } catch (err) {
      next(err);
    }
  });
  router.use('/keys', manageRouter);

  // The public read surface. Bearer key required; GET only; each endpoint
  // declares its scope and token cost.
  const publicRouter = express.Router();
  publicRouter.use(keyAuth);
  publicRouter.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return sendV1Error(
      res,
      v1Error('invalid_query', 'Only GET requests are supported.', { status: 405 }),
    );
  });

  // Map any thrown error onto the envelope: typed v1/store errors pass
  // through, known service codes map onto their status, and anything else
  // becomes a logged provider_error 502. Shared by the read surface's
  // handler and the router-level error middleware below.
  function mapError(err, req) {
    if (err && (err.v1 || (err.code && err.status))) return err;
    const code = (err && err.code) || 'provider_error';
    const status = ERROR_STATUS[code];
    if (status) {
      const headers =
        code === 'rate_limited' && !(err && err.headers) ? { 'Retry-After': 1 } : undefined;
      return v1Error(code, err.message || 'The request failed.', { status, headers });
    }
    console.error(`[api-v1] ${req && req.method} ${req && req.originalUrl} failed`, err);
    return v1Error('provider_error', 'The request could not be completed.', { status: 502 });
  }

  const handle = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      return sendV1Error(res, mapError(err, req));
    }
  };

  // Service capability document — the same inputs GET /api/config reports
  // (resolveMapConfig, resolveRoutingConfig, activeProviderName), in a
  // machine-readable shape. Deferred phases are named in notAvailable, never
  // advertised as live.
  publicRouter.get(
    '/capabilities',
    rateLimit(buckets, 1),
    handle(() => {
      const c = settings.resolveCapabilities();
      return {
        version: 'v1',
        service: 'Homeroom Maps API',
        capabilities: {
          search: {
            available: Boolean(c.searchProvider),
            provider: c.searchProvider,
            endpoints: ['/api/v1/search', '/api/v1/search/suggest'],
          },
          directions: {
            available: Boolean(c.routing && c.routing.configured),
            provider: c.routing && c.routing.provider,
            modes: (c.routing && c.routing.modes) || [],
            endpoints: ['/api/v1/directions'],
          },
          places: {
            available: Boolean(c.placeProvider),
            provider: c.placeProvider,
            endpoints: ['/api/v1/places', '/api/v1/places/{id}'],
          },
          community: {
            available: true,
            endpoints: ['/api/v1/community/proposals', '/api/v1/community/proposals/{id}'],
          },
          reports: {
            available: true,
            endpoints: ['/api/v1/reports', '/api/v1/reports/{id}'],
          },
        },
        notAvailable: [
          'business profiles',
          'transit',
          'weather',
          'traffic',
          'saved places, trips and any other private data',
          'writes of any kind',
        ],
        rateLimit: { requestsPerMinute: rateLimitPerMinute, directionsCost },
        scopes: SCOPES,
        attribution: '© OpenStreetMap contributors',
        docs: '/api/v1/openapi.yaml',
      };
    }),
  );

  // Search and suggestions (search/index.js run() — the internal contract,
  // projected). Language resolves from the explicit query param, then the
  // caller's Accept-Language header — an API key carries no platform locale.
  const searchParams = (req) => ({
    q: req.query.q,
    limit: req.query.limit,
    bbox: req.query.bbox,
    near: req.query.near,
    radius: req.query.radius,
    lang: req.query.lang,
  });
  const langOf = (req) => (typeof req.query.lang === 'string' && req.query.lang) || null;

  publicRouter.get(
    '/search',
    requireScope('search:read'),
    rateLimit(buckets, 1),
    handle(async (req) =>
      projectSearchResponse(await searchApi.run('search', searchParams(req), { lang: langOf(req) })),
    ),
  );
  publicRouter.get(
    '/search/suggest',
    requireScope('search:read'),
    rateLimit(buckets, 1),
    handle(async (req) =>
      projectSearchResponse(
        await searchApi.run('suggest', searchParams(req), { lang: langOf(req) }),
      ),
    ),
  );

  // Directions (routing/index.js run()). Costs 3 tokens: a route can fan out
  // to upstream waypoints. Served modes only — anything else answers the
  // provider's own unsupported_mode, unchanged from internal behaviour.
  publicRouter.get(
    '/directions',
    requireScope('routing:read'),
    rateLimit(buckets, directionsCost),
    handle(async (req) =>
      projectRoutingResponse(
        await routingApi.run({
          origin: req.query.origin,
          destination: req.query.destination,
          waypoints: req.query.waypoints,
          mode: req.query.mode,
        }),
      ),
    ),
  );

  // Places. The contract is wired; with no place provider connected (the
  // deliberate default) both routes answer the honest 501 not_configured
  // envelope, exactly as /api/places does today.
  const placeService = placesApi.createPlaceService();
  publicRouter.get(
    '/places',
    requireScope('places:read'),
    rateLimit(buckets, 1),
    handle(async (req) =>
      projectPlacesResponse(
        await placeService.getPlaces({
          q: req.query.q,
          near: req.query.near,
          radius: req.query.radius,
          bbox: req.query.bbox,
          limit: req.query.limit,
          lang: req.query.lang,
        }),
      ),
    ),
  );
  publicRouter.get(
    '/places/:id',
    requireScope('places:read'),
    rateLimit(buckets, 1),
    handle(async (req) =>
      projectPlaceResponse(await placeService.getPlaceDetails(req.params.id, { lang: langOf(req) })),
    ),
  );

  // Public community proposals. The store already excludes drafts and hidden
  // rows for every non-mine view; v1 additionally refuses the mine view (an
  // API key is not the person's browser session, and drafts are author-only)
  // and refuses any single proposal whose status is not public, so the
  // author-sees-own-draft rule of get() can never leak through the API.
  function refuseMine(req) {
    if (req.query.view === 'mine') {
      throw v1Error('invalid_query', 'The mine view is not available through the API.', {
        status: 400,
      });
    }
  }

  publicRouter.get(
    '/community/proposals',
    requireScope('community:read'),
    rateLimit(buckets, 1),
    handle(async (req) => {
      refuseMine(req);
      const feed = await communityStore.list(apiViewer(req.v1.key), {
        view: req.query.view,
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
        near: req.query.near,
        radius: req.query.radius,
      });
      return projectProposalFeed(feed);
    }),
  );

  publicRouter.get(
    '/community/proposals/:id',
    requireScope('community:read'),
    rateLimit(buckets, 1),
    handle(async (req) => {
      const out = await communityStore.get(apiViewer(req.v1.key), req.params.id);
      if (!PUBLIC_STATUSES.includes(out.status)) {
        throw v1Error('not_found', 'That proposal does not exist.', { status: 404 });
      }
      // Every success response carries attribution, details included.
      return { ...projectProposal(out), attribution: attributionFor() };
    }),
  );

  // Public reports. Same mine refusal; the report-specific filters and the
  // expired-report passthrough keep the internal parameter names, so the v1
  // docs and internal behaviour can never drift.
  publicRouter.get(
    '/reports',
    requireScope('reports:read'),
    rateLimit(buckets, 1),
    handle(async (req) => {
      refuseMine(req);
      const feed = await reportsStore.list(apiViewer(req.v1.key), {
        view: req.query.view,
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
        near: req.query.near,
        radius: req.query.radius,
        type: req.query.type,
        placeId: req.query.placeId,
        includeExpired: req.query.includeExpired,
      });
      return projectReportFeed(feed);
    }),
  );

  publicRouter.get(
    '/reports/:id',
    requireScope('reports:read'),
    rateLimit(buckets, 1),
    handle(async (req) => {
      const out = await reportsStore.get(apiViewer(req.v1.key), req.params.id);
      return { ...projectReport(out), attribution: attributionFor() };
    }),
  );

  // The public API's own document, hand-maintained in docs/. Key-authenticated
  // like everything else; it describes shapes and carries no data.
  let openapiCache = null;
  publicRouter.get('/openapi.yaml', (_req, res) => {
    if (openapiCache === null) {
      try {
        openapiCache = openapiPath ? fs.readFileSync(openapiPath, 'utf8') : '';
      } catch {
        openapiCache = '';
      }
    }
    if (!openapiCache) {
      return sendV1Error(res, v1Error('not_found', 'The API document is not available.', { status: 404 }));
    }
    return res.type('text/yaml; charset=utf-8').send(openapiCache);
  });

  router.use(publicRouter);

  // Unmatched v1 paths answer the envelope too, not the bare-string 401 the
  // platform gate would give them (the mount sits before that gate).
  router.use((_req, res) => {
    sendV1Error(res, v1Error('not_found', 'Unknown API endpoint.', { status: 404 }));
  });

  // Errors from the management surface (and any handler that called
  // next(err)) get the same envelope and mapping, so no v1 failure can ever
  // leak an HTML error page.
  // eslint-disable-next-line no-unused-vars -- Express identifies error
  // middleware by its four-argument signature.
  router.use((err, req, res, _next) => {
    sendV1Error(res, mapError(err, req));
  });

  return { router, publicRouter, manageRouter, buckets };
}

module.exports = { createApiV1, ERROR_STATUS, MAX_PAGE_LIMIT };
