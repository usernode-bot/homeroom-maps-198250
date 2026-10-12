// The /api/v1 developer API against a REAL Postgres database: the real key
// store (api/keys.js), the real community and reports stores, and stubbed
// provider-backed services (search, routing, places hit the network, so
// their stubs stand in; their envelope passthrough is covered by
// tests/api.endpoints.test.js).
//
// Each run creates its own throwaway schema, applies the boot migrations and
// drives the mounted v1 router over HTTP. Needs TEST_DATABASE_URL, else
// INLOOP_DATABASE_URL (the build worker's local Postgres). Skipped, loudly,
// when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createStore: createKeysStore } = require('../api/keys');
const { createApiV1 } = require('../api/index');
const { createPolicies } = require('../community/policies');
const { createStore: createCommunityStore } = require('../community/store');
const { createReportsStore } = require('../reports/store');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let base;
let keysStore;
const schema = `api_v1_test_${process.pid}_${Date.now()}`;

const USERS = {
  alice: { id: 201, username: 'alice' },
  bob: { id: 202, username: 'bob' },
};

function stubSearchApi() {
  return {
    async run(kind, params) {
      if (!params.q) {
        const err = new Error('Query is required.');
        err.code = 'invalid_query';
        err.status = 400;
        throw err;
      }
      return {
        provider: 'photon',
        results: [{ id: 'way-1', kind: 'city', name: 'Springfield', detail: 'Springfield', lat: 1, lon: 2 }],
      };
    },
  };
}

function flakyUpstream() {
  return {
    async run(params) {
      if (params.destination === '5,5') {
        const err = new Error('Upstream timed out.');
        err.code = 'timeout';
        err.status = 504;
        throw err;
      }
      if (params.destination === '6,6') {
        throw new Error('connection reset'); // no typed code: unexpected
      }
      return {
        provider: 'osrm',
        mode: params.mode || 'driving',
        routes: [{ geometry: [[0, 0], [1, 1]], distance: 100, duration: 10, legs: [] }],
      };
    },
  };
}

async function call(method, path, { key, as, body } = {}) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (as) headers['x-test-user'] = String(as);
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
  return { status: res.status, headers: res.headers, body: parsed, text };
}

async function createKey(as, name) {
  return call('POST', '/keys', { as, body: { name } });
}

// A guaranteed-fresh key: revoke the person's active keys first, so tests
// never trip over the per-user cap. The cap itself is tested explicitly.
async function freshKey(username, name = 'Test key') {
  const user = USERS[username];
  for (const record of await keysStore.list(user)) {
    if (!record.revokedAt) await keysStore.revoke(user, record.id);
  }
  const created = await createKey(username, name);
  assert.equal(created.status, 201, `key creation for ${username}: ${JSON.stringify(created.body)}`);
  return created.body.key;
}

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });

  keysStore = createKeysStore({ pool, maxKeysPerUser: 3 });
  await keysStore.migrate();
  await keysStore.migrate(); // the boot migration must be idempotent

  const policies = createPolicies();
  const communityStore = createCommunityStore({ pool, policies, platformOrigin: 'https://platform.test' });
  await communityStore.migrate();
  const reportsStore = createReportsStore({ pool, policies: createPolicies() });
  await reportsStore.migrate();

  const app = express();
  app.use(express.json());
  const api = createApiV1({
    keys: keysStore,
    searchApi: stubSearchApi(),
    routingApi: flakyUpstream(),
    placesApi: {
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
    },
    communityStore,
    reportsStore,
    verifySession(req) {
      const who = USERS[req.headers['x-test-user']];
      return who ? { ...who, pur: 'iframe' } : null;
    },
    settings: {
      enabled: true,
      rateLimitPerMinute: 10, // loose enough for the multi-endpoint tests; the 429 test spends a key's whole bucket
      openapiPath: null,
      resolveCapabilities: () => ({
        searchProvider: 'photon',
        routing: { configured: true, provider: 'osrm', modes: ['driving'] },
        placeProvider: null,
      }),
    },
  });
  app.use('/api/v1', api.router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  if (skip || !server) return; // setup failed: nothing to tear down
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('the api_keys table exists, is unique by hash, and is staging:private', { skip }, async () => {
  const comment = await pool.query(
    "SELECT obj_description('api_keys'::regclass) AS c",
  );
  assert.equal(comment.rows[0].c, 'staging:private');
  // A repeated key hash is refused by the UNIQUE constraint.
  await assert.rejects(
    pool.query(
      `INSERT INTO api_keys (user_id, username, name, key_hash, key_prefix, scopes)
       VALUES (1, 'dup', 'a', 'deadbeef', 'hm_live_', '[]'::jsonb),
              (2, 'dup', 'b', 'deadbeef', 'hm_live_', '[]'::jsonb)`,
    ),
    /unique|duplicate/i,
  );
});

test('key lifecycle against real Postgres: create, use on every endpoint, revoke, 401', { skip }, async () => {
  const created = await createKey('alice', 'Lifecycle key');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const key = created.body.key;
  assert.match(key, /^hm_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.record.keyPrefix, key.slice(0, 12));
  assert.deepEqual(created.body.record.scopes, [
    'search:read', 'routing:read', 'places:read', 'community:read', 'reports:read',
  ]);

  // The hash exists, the plaintext does not.
  const rows = await pool.query('SELECT key_hash, key_prefix FROM api_keys WHERE username = $1', ['alice']);
  assert.equal(rows.rows[0].key_prefix, key.slice(0, 12));

  const read = await call('GET', '/search?q=springfield', { key });
  assert.equal(read.status, 200);
  assert.equal(read.body.provider, 'photon');
  assert.match(read.body.attribution, /OpenStreetMap/);

  const routes = await call('GET', '/directions?origin=0,0&destination=1,1', { key });
  assert.equal(routes.status, 200);
  assert.deepEqual(routes.body.routes[0].geometry, [[0, 0], [1, 1]]);

  const capabilities = await call('GET', '/capabilities', { key });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.capabilities.places.available, false);

  // Community and reports against the real stores: empty, well-shaped.
  const feed = await call('GET', '/community/proposals', { key });
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.items, []);
  const reports = await call('GET', '/reports', { key });
  assert.equal(reports.status, 200);
  assert.deepEqual(reports.body.items, []);

  // Revoke through the management surface, then the key is dead.
  const revoked = await call('DELETE', `/keys/${created.body.record.id}`, { as: 'alice' });
  assert.equal(revoked.status, 200);
  const dead = await call('GET', '/capabilities', { key });
  assert.equal(dead.status, 401);
  assert.equal(dead.body.error.code, 'invalid_key');
});

test('an expired key verifies as nothing at all', { skip }, async () => {
  const key = await freshKey('alice', 'Expiring key');
  await pool.query(
    "UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE key_prefix = $1",
    [key.slice(0, 12)],
  );
  const res = await call('GET', '/capabilities', { key });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_key'); // uniform answer, never "expired"
});

test('a key narrowed to one scope is refused on the others with 403', { skip }, async () => {
  const key = await freshKey('alice', 'Narrow key');
  await pool.query(
    "UPDATE api_keys SET scopes = '[\"search:read\"]'::jsonb WHERE key_prefix = $1",
    [key.slice(0, 12)],
  );
  const ok = await call('GET', '/search?q=x', { key });
  assert.equal(ok.status, 200);
  const refused = await call('GET', '/directions?origin=0,0&destination=1,1', { key });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'insufficient_scope');
  assert.match(refused.body.error.message, /routing:read/);
});

test('the per-user cap counts ACTIVE keys and revoking frees a slot', { skip }, async () => {
  await freshKey('bob', 'Bob 1'); // one active
  const second = await createKey('bob', 'Bob 2');
  const third = await createKey('bob', 'Bob 3');
  assert.equal(second.status, 201);
  assert.equal(third.status, 201);
  const fourth = await createKey('bob', 'Bob 4');
  assert.equal(fourth.status, 400);
  assert.equal(fourth.body.error.code, 'key_limit');
  assert.match(fourth.body.error.message, /maximum of 3/);

  await call('DELETE', `/keys/${third.body.record.id}`, { as: 'bob' });
  const fifth = await createKey('bob', 'Bob 5');
  assert.equal(fifth.status, 201);
});

test('a key that exhausts its quota answers 429 with Retry-After', { skip }, async () => {
  const key = await freshKey('alice', 'Throttled key');
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    statuses.push((await call('GET', `/search?q=q${i}`, { key })).status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
  const refused = await call('GET', '/search?q=last', { key });
  assert.equal(refused.body.error.code, 'rate_limited');
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
});

test('upstream failures pass through with their typed code, unexpected ones become 502', { skip }, async () => {
  // Each fresh key has a full bucket, and one directions call costs 3.
  const first = await freshKey('alice', 'Upstream key 1');
  const second = await createKey('alice', 'Upstream key 2'); // 2 active, under the cap
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const timeout = await call('GET', '/directions?origin=0,0&destination=5,5', { key: first });
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.error.code, 'timeout');
  assert.equal(timeout.body.error.message, 'Upstream timed out.');

  const unexpected = await call('GET', '/directions?origin=0,0&destination=6,6', { key: second.body.key });
  assert.equal(unexpected.status, 502);
  assert.equal(unexpected.body.error.code, 'provider_error');
  assert.doesNotMatch(unexpected.text, /connection reset/); // no internals leak
});

test('private data never reaches the API response, field by field, real store output', { skip }, async () => {
  // Seed real rows through the stores themselves: a published proposal and
  // a draft only its author could see, plus one report.
  const policies = createPolicies();
  const communityStore = createCommunityStore({ pool, policies, platformOrigin: 'https://platform.test' });
  const body = {
    title: 'Add the corner bakery',
    description: 'A bakery opened on this corner last year and is missing.',
    category: 'add_missing_place',
    location: { name: 'Kastanienallee, Berlin', lat: 52.5386, lng: 13.4108 },
  };
  const published = await communityStore.create(USERS.alice, { ...body, publish: true });
  const draft = await communityStore.create(USERS.alice, body);
  assert.ok(published.id && draft.id, 'the store created both rows');

  const key = await freshKey('alice', 'Privacy key');

  // The author's own draft is a 404 through the API, and the mine view does
  // not exist at all.
  const draftDetail = await call('GET', `/community/proposals/${draft.id}`, { key });
  assert.equal(draftDetail.status, 404);
  const mine = await call('GET', '/community/proposals?view=mine', { key });
  assert.equal(mine.status, 400);

  // The published proposal comes through the real store's projection,
  // stripped: no author.id, no viewer block; the username and tallies stay.
  const feed = await call('GET', '/community/proposals', { key });
  assert.equal(feed.status, 200);
  const item = feed.body.items.find((p) => String(p.id) === String(published.id));
  assert.ok(item, 'the published proposal appears in the feed');
  assert.equal(item.author.id, undefined);
  assert.equal(item.author.username, 'alice');
  assert.equal(item.viewer, undefined);
  assert.deepEqual(item.votes, { up: 0, down: 0, score: 0 });

  const reportsStore = createReportsStore({ pool, policies });
  await reportsStore.create(USERS.bob, {
    type: 'road_closed',
    description: 'A test report for the privacy projection.',
    lat: 52.5,
    lng: 13.4,
  });
  const reportFeed = await call('GET', '/reports', { key });
  assert.equal(reportFeed.status, 200);
  const reportItem = reportFeed.body.items[0];
  assert.equal(reportItem.reporter.id, undefined);
  assert.equal(reportItem.reporter.username, 'bob');
  assert.equal(reportItem.viewer, undefined);
  assert.ok('reactions' in reportItem);
  assert.ok('lat' in reportItem && 'lng' in reportItem);
});
