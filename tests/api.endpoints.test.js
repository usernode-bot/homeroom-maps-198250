// Endpoint tests for the /api/v1 router (api/index.js) against stub domain
// services: envelopes, credential kinds, projections, the kill switch,
// GET-only, rate-limit accounting and the /keys management surface. No
// database: the keys store is an in-memory stand-in with the same contract
// as createStore (the real one is covered by tests/api.postgres.test.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const crypto = require('crypto');
const { createApiV1, MAX_PAGE_LIMIT } = require('../api/index');
const { SCOPES, generateKey, hashKey } = require('../api/keys');

// ---- in-memory keys store (createStore's contract, no Postgres) ---------------

function stubKeysStore({ cap = 5 } = {}) {
  const byId = new Map();
  let nextId = 1;
  return {
    async create({ user, name }) {
      const active = [...byId.values()].filter((r) => r.user_id === user.id && !r.revoked_at);
      if (active.length >= cap) {
        const err = new Error(`You already have the maximum of ${cap} API keys. Revoke one first.`);
        err.code = 'key_limit';
        err.status = 400;
        throw err;
      }
      const key = generateKey();
      const row = {
        id: nextId++,
        user_id: user.id,
        username: user.username,
        name: String(name || '').trim() || 'Unnamed key',
        key_hash: hashKey(key),
        key_prefix: key.slice(0, 12),
        scopes: [...SCOPES],
        created_at: new Date().toISOString(),
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      };
      byId.set(row.id, row);
      plaintextByHash.set(row.key_hash, key);
      return { key, record: toApi(row) };
    },
    async list(user) {
      return [...byId.values()]
        .filter((r) => r.user_id === user.id)
        .sort((a, b) => b.id - a.id)
        .map(toApi);
    },
    async revoke(user, rawId) {
      const id = Number.parseInt(rawId, 10);
      const row = byId.get(id);
      if (!row || row.user_id !== user.id || row.revoked_at) {
        const err = new Error('That key does not exist.');
        err.code = 'not_found';
        err.status = 404;
        throw err;
      }
      row.revoked_at = new Date().toISOString();
      return { revoked: true, id: String(row.id) };
    },
    async verify(presented) {
      if (typeof presented !== 'string' || !presented.startsWith('hm_live_')) return null;
      const row = [...byId.values()].find((r) => r.key_hash === hashKey(presented));
      if (!row || row.revoked_at) return null;
      return row;
    },
    async touch() {},
  };
}

function toApi(row) {
  return {
    id: String(row.id),
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// Maps a stored hash back to the one plaintext (so tests can call the API).
const plaintextByHash = new Map();

// ---- stub domain services ------------------------------------------------------

const searchProvider = 'photon';
const stubSearchApi = {
  async run(kind, params) {
    if (!params.q) {
      const err = new Error('Query is required.');
      err.code = 'invalid_query';
      err.status = 400;
      throw err;
    }
    return {
      provider: searchProvider,
      results: [
        {
          id: 'way-1',
          kind: 'city',
          name: 'Springfield',
          detail: 'Springfield, IL',
          lat: 39.8,
          lon: -89.0,
          address: { city: 'Springfield', country: 'United States' },
        },
      ],
    };
  },
};

const stubRoutingApi = {
  async run(params) {
    if (params.mode === 'hovercraft') {
      const err = new Error('Mode not served.');
      err.code = 'unsupported_mode';
      err.status = 400;
      throw err;
    }
    if (params.destination === '99,99') {
      const err = new Error('No route.');
      err.code = 'no_route';
      err.status = 404;
      throw err;
    }
    return {
      provider: 'osrm',
      mode: params.mode || 'driving',
      routes: [
        {
          geometry: [[0, 0], [1, 1]],
          distance: 1500,
          duration: 300,
          summary: 'Main Street',
          legs: [{ distance: 1500, duration: 300, steps: [{ name: 'Main Street', distance: 800, duration: 120, maneuver: { type: 'turn', modifier: 'left' } }] }],
        },
      ],
    };
  },
};

const stubPlacesApi = {
  createPlaceService() {
    return {
      async getPlaces() {
        const err = new Error('No place provider is configured.');
        err.code = 'not_configured';
        err.status = 501;
        throw err;
      },
      async getPlaceDetails() {
        const err = new Error('No place provider is configured.');
        err.code = 'not_configured';
        err.status = 501;
        throw err;
      },
    };
  },
};

const PUBLIC_PROPOSAL = {
  id: '12',
  author: { id: '7', username: 'alice' },
  title: 'Add a bike rack',
  description: 'By the station.',
  category: 'cycling',
  status: 'open',
  statusLabel: 'Open',
  createdAt: '2026-01-01T00:00:00.000Z',
  votes: { up: 3, down: 1 },
  viewer: { hasVoted: true, myVote: 'up' },
};

const stubCommunityStore = {
  async list(_viewer, q) {
    if (q.view === 'nearby' && !q.near) {
      const err = new Error('near is required.');
      err.code = 'invalid_query';
      err.status = 400;
      throw err;
    }
    return {
      view: q.view || 'recent',
      items: [PUBLIC_PROPOSAL],
      hasMore: true,
      nextOffset: 20,
      ...(q.view === 'nearby' ? { near: { lat: 1, lng: 2 }, radiusKm: q.radius } : {}),
    };
  },
  async get(_viewer, id) {
    if (id === '77') {
      // An author's own draft: the internal get() serves it to its author,
      // the API must answer 404.
      return { ...PUBLIC_PROPOSAL, id: '77', status: 'draft', author: { id: '7', username: 'alice' } };
    }
    return PUBLIC_PROPOSAL;
  },
};

const PUBLIC_REPORT = {
  id: '5',
  type: 'roadwork',
  description: 'Closed lane.',
  lat: 1.5,
  lng: 2.5,
  reporter: { id: '9', username: 'bob' },
  status: 'open',
  reactions: { confirm: 2, disagree: 0 },
  viewer: { hasReacted: true },
};

const stubReportsStore = {
  async list(_viewer, q) {
    return {
      view: q.view || 'recent',
      items: [PUBLIC_REPORT],
      hasMore: false,
      nextOffset: null,
    };
  },
  async get() {
    return PUBLIC_REPORT;
  },
};

// ---- harness --------------------------------------------------------------------

const OPENAPI_PATH = require('path').join(__dirname, '..', 'docs', 'openapi.yaml');

function buildApp({ enabled = true, rateLimitPerMinute = 60, openapiPath = OPENAPI_PATH } = {}) {
  const app = express();
  const keys = stubKeysStore();
  const api = createApiV1({
    keys,
    searchApi: stubSearchApi,
    routingApi: stubRoutingApi,
    placesApi: stubPlacesApi,
    communityStore: stubCommunityStore,
    reportsStore: stubReportsStore,
    verifySession(req) {
      const who = req.headers['x-test-user'];
      const ids = { alice: 7, bob: 8 };
      return who && ids[who] ? { id: ids[who], username: who, pur: 'iframe' } : null;
    },
    settings: {
      enabled,
      rateLimitPerMinute,
      openapiPath,
      resolveCapabilities: () => ({
        searchProvider,
        routing: { configured: true, provider: 'osrm', modes: ['driving'] },
        placeProvider: null,
      }),
    },
  });
  app.use('/api/v1', api.router);
  return { app, keys };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const USER_IDS = { alice: 7, bob: 8 };

async function makeKey(keys, username = 'alice') {
  const { key } = await keys.create({ user: { id: USER_IDS[username], username }, name: 'test' });
  return key;
}

async function call(base, method, path, { key, as, body, requestId } = {}) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (as) headers['x-test-user'] = as;
  if (requestId) headers['x-request-id'] = requestId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

// ---- tests ------------------------------------------------------------------------

test('the v1 page ceiling is 20', () => {
  assert.equal(MAX_PAGE_LIMIT, 20);
});

test('without a key the public surface answers the envelope 401 missing_key', async () => {
  const { app } = buildApp();
  const { server, base } = await listen(app);
  try {
    const res = await call(base, 'GET', '/api/v1/search?q=springfield');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'missing_key');
    assert.match(res.body.error.message, /Authorization: Bearer/);
  } finally {
    server.close();
  }
});

test('a wrong key, an unknown scheme and a key in the URL are all refused without revealing state', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const wrong = await call(base, 'GET', '/api/v1/search?q=x', {
      key: 'hm_live_' + 'A'.repeat(43),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'invalid_key');
    assert.equal(wrong.body.error.message, 'That API key is not valid.');

    const basic = await call(base, 'GET', '/api/v1/search?q=x', { key: 'not-a-bearer' });
    assert.equal(basic.status, 401);
    assert.equal(basic.body.error.code, 'invalid_key');

    const inUrl = await call(base, 'GET', '/api/v1/search?q=x&key=hm_live_abc');
    assert.equal(inUrl.status, 401);
    assert.equal(inUrl.body.error.code, 'invalid_key');
    assert.match(inUrl.body.error.message, /Authorization header/);

    // A valid key really does work, proving the 401s above are the key gate.
    const key = await makeKey(keys);
    const good = await call(base, 'GET', '/api/v1/search?q=springfield', { key });
    assert.equal(good.status, 200);
  } finally {
    server.close();
  }
});

test('the kill switch answers 503 api_disabled on every route, management included', async () => {
  const { app } = buildApp({ enabled: false });
  const { server, base } = await listen(app);
  try {
    for (const path of ['/api/v1/search?q=x', '/api/v1/capabilities', '/api/v1/keys']) {
      const res = await call(base, 'GET', path, { as: 'alice' });
      assert.equal(res.status, 503, path);
      assert.equal(res.body.error.code, 'api_disabled');
    }
  } finally {
    server.close();
  }
});

test('the public surface is GET-only: POST answers 405 with the envelope', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const res = await call(base, 'POST', '/api/v1/search', { key, body: { q: 'x' } });
    assert.equal(res.status, 405);
    assert.equal(res.body.error.code, 'invalid_query');
    assert.match(res.body.error.message, /Only GET requests/);
  } finally {
    server.close();
  }
});

test('every response echoes a sanitized x-request-id', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const echoed = await call(base, 'GET', '/api/v1/capabilities', { key, requestId: 'my-trace-1' });
    assert.equal(echoed.headers.get('x-request-id'), 'my-trace-1');
    const generated = await call(base, 'GET', '/api/v1/capabilities', { key });
    assert.match(generated.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    // A hostile header is replaced, never reflected.
    const hostile = await call(base, 'GET', '/api/v1/capabilities', {
      key,
      requestId: '<script>alert(1)</script>',
    });
    assert.doesNotMatch(hostile.headers.get('x-request-id'), /[<>()]/);
  } finally {
    server.close();
  }
});

test('/capabilities reports what is live, what is not, the limits and the scopes', async () => {
  const { app, keys } = buildApp({ rateLimitPerMinute: 45 });
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const res = await call(base, 'GET', '/api/v1/capabilities', { key });
    assert.equal(res.status, 200);
    const doc = res.body;
    assert.equal(doc.version, 'v1');
    assert.equal(doc.capabilities.search.available, true);
    assert.equal(doc.capabilities.search.provider, searchProvider);
    assert.equal(doc.capabilities.directions.available, true);
    assert.deepEqual(doc.capabilities.directions.modes, ['driving']);
    assert.equal(doc.capabilities.places.available, false); // no provider configured
    assert.equal(doc.capabilities.community.available, true);
    assert.equal(doc.rateLimit.requestsPerMinute, 45);
    assert.equal(doc.rateLimit.directionsCost, 3);
    assert.deepEqual(doc.scopes, SCOPES);
    assert.match(doc.attribution, /OpenStreetMap/);
    assert.ok(doc.notAvailable.some((s) => /weather|traffic|transit/.test(s)));
    assert.ok(doc.notAvailable.some((s) => /private/.test(s)));
    assert.equal(doc.docs, '/api/v1/openapi.yaml');
  } finally {
    server.close();
  }
});

test('/search and /search/suggest project the allowlisted shape only', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const res = await call(base, 'GET', '/api/v1/search?q=springfield', { key });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['attribution', 'provider', 'results']);
    assert.equal(res.body.provider, searchProvider);
    assert.match(res.body.attribution, /OpenStreetMap/);
    const r = res.body.results[0];
    // The allowlist: public result fields, and nothing caller-relative.
    assert.deepEqual(Object.keys(r).sort(), [
      'address', 'addressLine', 'detail', 'id', 'kind', 'lat', 'localName', 'lon', 'name',
    ]);
    assert.equal(r.address.city, 'Springfield');
    const suggest = await call(base, 'GET', '/api/v1/search/suggest?q=springfield', { key });
    assert.equal(suggest.status, 200);
    assert.equal(suggest.body.results.length, 1);
  } finally {
    server.close();
  }
});

test('search refuses a request without a query with the envelope 400', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const res = await call(base, 'GET', '/api/v1/search', { key });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_query');
  } finally {
    server.close();
  }
});

test('/directions projects routes and passes provider failures through unchanged', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const res = await call(base, 'GET', '/api/v1/directions?origin=0,0&destination=1,1', { key });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['attribution', 'mode', 'provider', 'routes']);
    const route = res.body.routes[0];
    assert.deepEqual(Object.keys(route).sort(), ['distance', 'duration', 'geometry', 'legs', 'summary']);
    assert.deepEqual(route.geometry, [[0, 0], [1, 1]]);
    assert.equal(route.legs[0].steps[0].maneuver.type, 'turn');

    const unsupported = await call(base, 'GET', '/api/v1/directions?origin=0,0&destination=1,1&mode=hovercraft', { key });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.error.code, 'unsupported_mode');

    const noRoute = await call(base, 'GET', '/api/v1/directions?origin=0,0&destination=99,99', { key });
    assert.equal(noRoute.status, 404);
    assert.equal(noRoute.body.error.code, 'no_route');
  } finally {
    server.close();
  }
});

test('directions costs 3 tokens: the second route on a 3-per-minute key is 429 with Retry-After', async () => {
  const { app, keys } = buildApp({ rateLimitPerMinute: 3 });
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const first = await call(base, 'GET', '/api/v1/directions?origin=0,0&destination=1,1', { key });
    assert.equal(first.status, 200);
    const second = await call(base, 'GET', '/api/v1/directions?origin=0,0&destination=1,1', { key });
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'rate_limited');
    const retry = Number(second.headers.get('retry-after'));
    assert.ok(retry >= 1);
  } finally {
    server.close();
  }
});

test('places answers the honest 501 not_configured while no provider is connected', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    for (const path of ['/api/v1/places?q=coffee', '/api/v1/places/abc']) {
      const res = await call(base, 'GET', path, { key });
      assert.equal(res.status, 501, path);
      assert.equal(res.body.error.code, 'not_configured');
      assert.match(res.body.error.message, /place provider/i);
    }
  } finally {
    server.close();
  }
});

test('community feed: mine is refused, drafts never appear, the viewer block is stripped', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);

    const mine = await call(base, 'GET', '/api/v1/community/proposals?view=mine', { key });
    assert.equal(mine.status, 400);
    assert.equal(mine.body.error.code, 'invalid_query');

    const feed = await call(base, 'GET', '/api/v1/community/proposals', { key });
    assert.equal(feed.status, 200);
    assert.deepEqual(Object.keys(feed.body).sort(), ['attribution', 'hasMore', 'items', 'nextOffset', 'view']);
    const item = feed.body.items[0];
    assert.deepEqual(Object.keys(item).sort(), [
      'attachments', 'author', 'category', 'categoryLabel', 'createdAt', 'description',
      'id', 'location', 'publishedAt', 'status', 'statusChangedAt', 'statusLabel', 'title',
      'updatedAt', 'votes',
    ]);
    assert.equal(item.author.id, undefined); // no platform user id
    assert.equal(item.author.username, 'alice');
    assert.equal(item.viewer, undefined); // no viewer block
    assert.deepEqual(item.votes, { up: 3, down: 1, score: 2 });

    const nearby = await call(base, 'GET', '/api/v1/community/proposals?view=nearby&near=1,2&radius=5', { key });
    assert.equal(nearby.status, 200);
    assert.deepEqual(nearby.body.near, { lat: 1, lng: 2 }); // the nearby echo comes back on the feed
    assert.equal(nearby.body.radiusKm, '5');

    const draft = await call(base, 'GET', '/api/v1/community/proposals/77', { key });
    assert.equal(draft.status, 404);
    assert.equal(draft.body.error.code, 'not_found');
  } finally {
    server.close();
  }
});

test('reports: mine is refused and the projection strips reporter identity and viewer state', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const mine = await call(base, 'GET', '/api/v1/reports?view=mine', { key });
    assert.equal(mine.status, 400);

    const feed = await call(base, 'GET', '/api/v1/reports?type=roadwork&placeId=p1&includeExpired=true', { key });
    assert.equal(feed.status, 200);
    const item = feed.body.items[0];
    assert.deepEqual(Object.keys(item).sort(), [
      'createdAt', 'description', 'effectiveStatus', 'expiresAt', 'id', 'lat', 'lng',
      'place', 'reactions', 'reporter', 'status', 'statusLabel', 'type', 'typeLabel', 'updatedAt',
    ]);
    assert.equal(item.reporter.id, undefined);
    assert.equal(item.viewer, undefined);
    assert.deepEqual(item.reactions, { confirm: 2, disagree: 0 });

    const detail = await call(base, 'GET', '/api/v1/reports/5', { key });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, '5');
  } finally {
    server.close();
  }
});

test('unknown v1 paths answer the envelope: 404 with a key, 401 without (no route probing)', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const authed = await call(base, 'GET', '/api/v1/definitely-not-here', { key });
    assert.equal(authed.status, 404);
    assert.equal(authed.body.error.code, 'not_found');
    // Without a key the surface hides which paths exist: the envelope 401,
    // never the platform gate's bare string.
    const anon = await call(base, 'GET', '/api/v1/definitely-not-here');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'missing_key');
    assert.match(anon.body.error.message, /Authorization: Bearer/);
  } finally {
    server.close();
  }
});

test('the openapi document is served to a key, and 404s (in the envelope) when absent', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const res = await fetch(base + '/api/v1/openapi.yaml', { headers: { authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/yaml/);
    const text = await res.text();
    assert.match(text, /openapi: 3\.1\.0/);
    assert.match(text, /\/community\/proposals\/\{id\}/);
  } finally {
    server.close();
  }

  const missing = buildApp({ openapiPath: '/definitely/not/here.yaml' });
  const s2 = await listen(missing.app);
  try {
    const key = await makeKey(missing.keys);
    const res = await call(s2.base, 'GET', '/api/v1/openapi.yaml', { key });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  } finally {
    s2.server.close();
  }
});

// ---- the /keys management surface --------------------------------------------------

test('the /keys surface is session-gated: no session 401, an API key 404', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const anon = await call(base, 'GET', '/api/v1/keys');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'missing_key');

    const key = await makeKey(keys);
    const viaKey = await call(base, 'GET', '/api/v1/keys', { key });
    assert.equal(viaKey.status, 404); // the route does not exist for an API key
    assert.equal(viaKey.body.error.code, 'not_found');
  } finally {
    server.close();
  }
});

test('the full key lifecycle through HTTP: create (shown once), list, use, revoke, dead key', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const created = await call(base, 'POST', '/api/v1/keys', { as: 'alice', body: { name: 'My script' } });
    assert.equal(created.status, 201);
    assert.match(created.body.key, /^hm_live_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.body.record.name, 'My script');
    assert.equal(created.body.record.keyHash, undefined); // the hash never leaves

    // The plaintext works on the read surface.
    const read = await call(base, 'GET', '/api/v1/capabilities', { key: created.body.key });
    assert.equal(read.status, 200);

    const list = await call(base, 'GET', '/api/v1/keys', { as: 'alice' });
    assert.equal(list.status, 200);
    assert.equal(list.body.keys.length, 1);
    assert.equal(list.body.keys[0].keyPrefix, created.body.key.slice(0, 12));
    assert.equal(JSON.stringify(list.body.keys).includes(created.body.key), false); // never listed

    const revoked = await call(base, 'DELETE', `/api/v1/keys/${created.body.record.id}`, { as: 'alice' });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body, { revoked: true, id: created.body.record.id });

    const dead = await call(base, 'GET', '/api/v1/capabilities', { key: created.body.key });
    assert.equal(dead.status, 401);
    assert.equal(dead.body.error.code, 'invalid_key');

    const again = await call(base, 'DELETE', `/api/v1/keys/${created.body.record.id}`, { as: 'alice' });
    assert.equal(again.status, 404);
  } finally {
    server.close();
  }
});

test('the per-user key cap is enforced through HTTP with the envelope', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    // cap 5 in the stub; create six and expect the sixth to refuse.
    let last = null;
    for (let i = 0; i < 6; i += 1) {
      last = await call(base, 'POST', '/api/v1/keys', { as: 'alice', body: { name: `Key ${i + 1}` } });
    }
    assert.equal(last.status, 400);
    assert.equal(last.body.error.code, 'key_limit');
    assert.match(last.body.error.message, /maximum of 5/);
  } finally {
    server.close();
  }
});

test('a key cannot revoke another person\'s key', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const aliceKey = await keys.create({ user: { id: USER_IDS.alice, username: 'alice' }, name: 'alice key' });
    const res = await call(base, 'DELETE', `/api/v1/keys/${aliceKey.record.id}`, { as: 'bob' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('no key material ever appears in a response body', async () => {
  const { app, keys } = buildApp();
  const { server, base } = await listen(app);
  try {
    const key = await makeKey(keys);
    const paths = ['/api/v1/capabilities', '/api/v1/search?q=x', '/api/v1/keys'];
    for (const path of paths) {
      const res = await call(base, 'GET', path, { key, as: 'alice' });
      assert.equal(JSON.stringify(res.body).includes(key), false, path);
    }
  } finally {
    server.close();
  }
});
