// Unit tests for the /api/v1 middleware (api/middleware.js): the envelope,
// the per-key token bucket with an injected clock, bearer parsing, the
// uniform 401s, scope checks, rate limiting with Retry-After, and session
// enforcement. No database, no network: the keys store and logger are stubs.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  v1Error,
  sendV1Error,
  createKeyBuckets,
  createKeyAuth,
  requireScope,
  rateLimit,
  requireSession,
  parseBearer,
  QUERY_STRING_KEY,
  MALFORMED,
  LAST_USED_THROTTLE_MS,
} = require('../api/middleware');

// ---- helpers ----------------------------------------------------------------

// A minimal res stand-in that records status, headers and the JSON body.
function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    set(name, value) {
      res.headers[String(name).toLowerCase()] = String(value);
      return res;
    },
    type() {
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function fakeReq({ headers = {}, query = {} } = {}) {
  return { headers, query };
}

function bodyCode(res) {
  return res.body && res.body.error && res.body.error.code;
}

// ---- envelope ----------------------------------------------------------------

test('v1Error carries code, status and the v1 marker; headers stay out of the body', () => {
  const err = v1Error('rate_limited', 'Slow down.', { status: 429, headers: { 'Retry-After': 7 } });
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.status, 429);
  assert.equal(err.v1, true);
  assert.deepEqual(err.headers, { 'Retry-After': 7 });
});

test('sendV1Error writes the one envelope and applies the error headers', () => {
  const res = fakeRes();
  sendV1Error(res, v1Error('rate_limited', 'Too many requests.', { status: 429, headers: { 'Retry-After': 9 } }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '9');
  assert.deepEqual(res.body, { error: { code: 'rate_limited', message: 'Too many requests.' } });
});

test('sendV1Error falls back to provider_error 502 for a shapeless error', () => {
  const res = fakeRes();
  sendV1Error(res, new Error('boom'));
  assert.equal(res.statusCode, 502);
  assert.equal(bodyCode(res), 'provider_error');
});

// ---- token bucket ------------------------------------------------------------

test('the bucket starts full and drains by cost, atomically', () => {
  let now = 0;
  const buckets = createKeyBuckets({ perMinute: 6, nowMs: () => now });
  assert.equal(buckets.capacity, 6);
  assert.ok(buckets.tryTake('k', 2).ok);
  assert.ok(buckets.tryTake('k', 3).ok); // 5 spent of 6
  assert.ok(buckets.tryTake('k', 1).ok); // 6 spent
  const third = buckets.tryTake('k', 1);
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSeconds >= 1);
});

test('the bucket refills continuously and never exceeds capacity', () => {
  let now = 0;
  const buckets = createKeyBuckets({ perMinute: 60, nowMs: () => now }); // 1 token/second
  for (let i = 0; i < 60; i += 1) assert.ok(buckets.tryTake('k', 1).ok);
  assert.equal(buckets.tryTake('k', 1).ok, false);
  now += 1500; // 1.5 tokens
  const result = buckets.tryTake('k', 1);
  assert.equal(result.ok, true);
  now += 120_000; // far past the cap
  assert.ok(buckets.tryTake('k', 60).ok); // a full burst again, never more
  assert.equal(buckets.tryTake('k', 1).ok, false);
});

test('Retry-After math: at 2/minute the third take of 1 waits ~30s', () => {
  let now = 0;
  const buckets = createKeyBuckets({ perMinute: 2, nowMs: () => now });
  assert.ok(buckets.tryTake('k').ok);
  assert.ok(buckets.tryTake('k').ok);
  const third = buckets.tryTake('k');
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSeconds >= 29 && third.retryAfterSeconds <= 31);
});

test('a cost larger than capacity is never half-taken', () => {
  let now = 0;
  const buckets = createKeyBuckets({ perMinute: 2, nowMs: () => now });
  const first = buckets.tryTake('k', 5); // > capacity: refused…
  assert.equal(first.ok, false);
  // …and nothing was spent by the refusal.
  assert.ok(buckets.tryTake('k', 1).ok);
});

test('keys are isolated: one key draining does not throttle another', () => {
  let now = 0;
  const buckets = createKeyBuckets({ perMinute: 1, nowMs: () => now });
  assert.ok(buckets.tryTake('a').ok);
  assert.equal(buckets.tryTake('a').ok, false);
  assert.ok(buckets.tryTake('b').ok);
});

// ---- bearer parsing -----------------------------------------------------------

test('parseBearer accepts the header form and rejects keys in the URL', () => {
  assert.equal(parseBearer(fakeReq({ headers: { authorization: 'Bearer hm_live_abc' } })), 'hm_live_abc');
  assert.equal(parseBearer(fakeReq({ headers: { authorization: 'bearer hm_live_abc' } })), 'hm_live_abc');
  assert.equal(parseBearer(fakeReq({})), null);
  assert.equal(parseBearer(fakeReq({ query: { key: 'hm_live_abc' } })), QUERY_STRING_KEY);
  assert.equal(parseBearer(fakeReq({ query: { api_key: 'x' } })), QUERY_STRING_KEY);
  assert.equal(parseBearer(fakeReq({ headers: { authorization: 'hm_live_abc' } })), MALFORMED);
  assert.equal(parseBearer(fakeReq({ headers: { authorization: 'Bearer  ' } })), MALFORMED);
  assert.equal(parseBearer(fakeReq({ headers: { authorization: `Bearer ${'x'.repeat(201)}` } })), MALFORMED);
});

// ---- key auth -----------------------------------------------------------------

function stubKeys(verifyResult) {
  const touches = [];
  return {
    verify: async () => verifyResult,
    touch: async (id) => touches.push(id),
    touches,
  };
}

const KEY_ROW = {
  id: 42,
  user_id: 7,
  username: 'alice',
  key_prefix: 'hm_live_abcd',
  scopes: ['search:read'],
};

test('key auth attaches the read-only viewer and redacts the Authorization header', async () => {
  const keys = stubKeys({ ...KEY_ROW });
  const auth = createKeyAuth({ keys });
  const req = fakeReq({ headers: { authorization: 'Bearer hm_live_secret' } });
  let nextCalled = false;
  await auth(req, fakeRes(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.headers.authorization, undefined); // redacted before any handler
  assert.equal(req.v1.kind, 'key');
  assert.deepEqual(req.v1.user, { id: '7', username: 'alice', reviewer: false });
});

test('every key failure answers the same uniform 401 invalid_key', async () => {
  for (const verifyResult of [null]) {
    const auth = createKeyAuth({ keys: stubKeys(verifyResult) });
    const req = fakeReq({ headers: { authorization: 'Bearer hm_live_deadbeef' } });
    const res = fakeRes();
    await auth(req, res, () => assert.fail('next must not run'));
    assert.equal(res.statusCode, 401);
    assert.equal(bodyCode(res), 'invalid_key');
    assert.equal(res.body.error.message, 'That API key is not valid.');
  }
  // Unknown scheme is the same answer as a wrong key: state stays unprobeable.
  const auth = createKeyAuth({ keys: stubKeys(null) });
  const res = fakeRes();
  await auth(fakeReq({ headers: { authorization: 'Basic zz' } }), res, () => assert.fail('next'));
  assert.equal(res.statusCode, 401);
  assert.equal(bodyCode(res), 'invalid_key');
  assert.equal(res.body.error.message, 'That API key is not valid.');
});

test('a missing key answers missing_key; a query-string key answers invalid_key with header guidance', async () => {
  const auth = createKeyAuth({ keys: stubKeys(null) });

  const noHeader = fakeRes();
  await auth(fakeReq({}), noHeader, () => assert.fail('next'));
  assert.equal(noHeader.statusCode, 401);
  assert.equal(bodyCode(noHeader), 'missing_key');

  const inUrl = fakeRes();
  await auth(fakeReq({ query: { key: 'hm_live_x' } }), inUrl, () => assert.fail('next'));
  assert.equal(inUrl.statusCode, 401);
  assert.equal(bodyCode(inUrl), 'invalid_key');
  assert.match(inUrl.body.error.message, /Authorization header/);
});

test('an invalid key logs its PREFIX only, and a stranger value logs "unrecognized"', async () => {
  const logs = [];
  const auth = createKeyAuth({ keys: stubKeys(null), log: (e) => logs.push(e) });
  await auth(fakeReq({ headers: { authorization: 'Bearer hm_live_deadbeef00' } }), fakeRes(), () => {});
  await auth(fakeReq({ headers: { authorization: 'Bearer sk_something_else' } }), fakeRes(), () => {});
  assert.deepEqual(logs[0], { event: 'invalid_key', keyPrefix: 'hm_live_dead' });
  assert.deepEqual(logs[1], { event: 'invalid_key', keyPrefix: 'unrecognized' });
});

test('a verify failure answers 502, not a fabricated 401', async () => {
  const keys = { verify: async () => { throw new Error('db down'); }, touch: async () => {} };
  const auth = createKeyAuth({ keys });
  const res = fakeRes();
  await auth(fakeReq({ headers: { authorization: 'Bearer hm_live_x' } }), res, () => assert.fail('next'));
  assert.equal(res.statusCode, 502);
  assert.equal(bodyCode(res), 'provider_error');
});

test('usage tracking is throttled to one write per key per minute and never fails a request', async () => {
  // Start past the throttle window so the very first request writes.
  let now = LAST_USED_THROTTLE_MS + 1000;
  const keys = stubKeys({ ...KEY_ROW });
  const auth = createKeyAuth({ keys, nowMs: () => now });

  const run = async () => {
    let called = false;
    await auth(fakeReq({ headers: { authorization: 'Bearer hm_live_k' } }), fakeRes(), () => {
      called = true;
    });
    return called;
  };

  assert.ok(await run());
  assert.ok(await run()); // within the throttle window: no second write
  assert.equal(keys.touches.length, 1);
  now += LAST_USED_THROTTLE_MS;
  assert.ok(await run());
  assert.equal(keys.touches.length, 2);
});

// ---- scopes and rate limit -----------------------------------------------------

test('requireScope refuses a key without the scope and passes one with it', () => {
  const missing = fakeRes();
  requireScope('routing:read')({ v1: { key: { scopes: ['search:read'] } } }, missing, () => assert.fail('next'));
  assert.equal(missing.statusCode, 403);
  assert.equal(bodyCode(missing), 'insufficient_scope');
  assert.match(missing.body.error.message, /routing:read/);

  let called = false;
  requireScope('routing:read')(
    { v1: { key: { scopes: ['search:read', 'routing:read'] } } },
    fakeRes(),
    () => {
      called = true;
    },
  );
  assert.equal(called, true);

  const noKey = fakeRes();
  requireScope('search:read')({ v1: {} }, noKey, () => assert.fail('next'));
  assert.equal(noKey.statusCode, 401);
  assert.equal(bodyCode(noKey), 'missing_key');
});

test('rateLimit spends the cost and answers 429 with Retry-After when exhausted', () => {
  let now = 0;
  const buckets = createKeyBuckets({ perMinute: 3, nowMs: () => now });

  let called = false;
  rateLimit(buckets, 2)({ v1: { key: { id: 9 } } }, fakeRes(), () => {
    called = true;
  });
  assert.equal(called, true);

  const spent = fakeRes();
  rateLimit(buckets, 2)({ v1: { key: { id: 9 } } }, spent, () => assert.fail('next'));
  assert.equal(spent.statusCode, 429);
  assert.equal(bodyCode(spent), 'rate_limited');
  const retryAfter = Number(spent.headers['retry-after']);
  assert.ok(retryAfter >= 1);
  assert.match(spent.body.error.message, new RegExp(String(retryAfter)));
});

test('rateLimit without a key answers missing_key', () => {
  const res = fakeRes();
  rateLimit(createKeyBuckets({ perMinute: 10 }), 1)({ v1: {} }, res, () => assert.fail('next'));
  assert.equal(res.statusCode, 401);
  assert.equal(bodyCode(res), 'missing_key');
});

// ---- session enforcement --------------------------------------------------------

test('requireSession lets a session through, 404s a bearer key, 401s nobody', () => {
  let called = false;
  requireSession()({ v1: { kind: 'session' } }, fakeRes(), () => {
    called = true;
  });
  assert.equal(called, true);

  const keyRes = fakeRes();
  requireSession()({ v1: { kind: 'key' } }, keyRes, () => assert.fail('next'));
  assert.equal(keyRes.statusCode, 404); // the route does not exist for an API key
  assert.equal(bodyCode(keyRes), 'not_found');

  const noneRes = fakeRes();
  requireSession()({ v1: { kind: 'none' } }, noneRes, () => assert.fail('next'));
  assert.equal(noneRes.statusCode, 401);
  assert.equal(bodyCode(noneRes), 'missing_key');
});
