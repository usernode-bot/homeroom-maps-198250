// Middleware for the /api/v1 developer API (Phase 12K): per-key auth, the
// per-key token bucket, scope checks and the shared error envelope.
//
// Everything here is dependency-injected (the keys store, the session
// verifier, the clock, the logger), so tests drive each branch without a
// database, a network or real time. No new package is required: the bucket
// follows the same refill math as search/rate-limit.js's TokenBucket (the
// repo's existing outbound limiter) with one addition — a per-request COST —
// so /api/v1/directions can spend 3 tokens at once.
'use strict';

const LAST_USED_THROTTLE_MS = 60_000; // one last_used_at write per key per minute at most
const MAX_KEY_LENGTH = 200; // bearer values longer than any real key are malformed

// Typed error for the v1 envelope. `headers` (e.g. Retry-After) ride on the
// response, never in the body.
function v1Error(code, message, { status = 400, headers, fields } = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.v1 = true;
  if (headers) err.headers = headers;
  if (fields) err.fields = fields;
  return err;
}

// One envelope for every v1 response body, success or failure shaped apart:
// { error: { code, message } } — the same shape the app's internal routes
// answer typed errors with (server.js SEARCH_ERROR_STATUS and friends).
function sendV1Error(res, err) {
  const code = (err && err.code) || 'provider_error';
  const status = (err && err.status) || 502;
  const message = (err && err.message) || 'The request could not be completed.';
  if (err && err.headers) {
    for (const [name, value] of Object.entries(err.headers)) res.set(name, String(value));
  }
  return res.status(status).json({
    error: { code, message, ...(err && err.fields ? { fields: err.fields } : {}) },
  });
}

// Per-key token bucket, one instance per mounted API. Math mirrors
// search/rate-limit.js: tokens refill continuously at refillPerSecond up to
// the capacity, and the clock is injected so tests drive timing. The one
// addition is `cost`: a request may spend more than one token at once
// (directions spends 3), taken atomically — never half-taken.
function createKeyBuckets({ perMinute, nowMs = () => Date.now() }) {
  const capacity = Math.max(1, Math.floor(Number(perMinute) || 60));
  const refillPerSecond = capacity / 60;
  const buckets = new Map();

  function bucketFor(id) {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: nowMs() };
      buckets.set(id, bucket);
    }
    return bucket;
  }

  function tryTake(id, cost = 1) {
    const need = Math.max(1, Math.floor(Number(cost) || 1));
    const bucket = bucketFor(id);
    const now = nowMs();
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens >= need) {
      bucket.tokens -= need;
      return { ok: true, retryAfterSeconds: 0 };
    }
    const wait = Math.max(1, Math.ceil((need - bucket.tokens) / refillPerSecond));
    return { ok: false, retryAfterSeconds: wait };
  }

  return { tryTake, capacity, refillPerSecond };
}

// The platform-JWT verifier for the key-management surface, built from the
// same three pinned values server.js's own gate uses (RS256, issuer
// usernode, audience usernode:app:<id>). Returns a verifySession(req)
// function: the verified claims, or null. This NEVER accepts a bearer API
// key — the two credential types are checked separately.
function createSessionVerifier({ publicKey, audience }) {
  let jwt;
  return function verifySession(req) {
    if (!publicKey || !audience) return null;
    const token = req.query.token || req.headers['x-usernode-token'];
    if (!token) return null;
    if (!jwt) jwt = require('jsonwebtoken');
    try {
      const claims = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience,
      });
      return claims && claims.pur === 'iframe' ? claims : null;
    } catch {
      return null;
    }
  };
}

// Bearer parsing for the read surface. Returns the presented key string, or
// null when no Authorization header was sent, or the sentinel MISSING when a
// query-string key was used (rejected outright — keys in URLs end up in logs
// and history), or MALFORMED when the header exists but carries no plausible
// key. The caller turns each into its 401 code.
const QUERY_STRING_KEY = Symbol('query-string-key');
const MALFORMED = Symbol('malformed-bearer');

function parseBearer(req) {
  const header = req.headers.authorization;
  if (req.query.key != null || req.query.api_key != null) return QUERY_STRING_KEY;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header));
  if (!match) return MALFORMED;
  const value = match[1];
  if (value.length > MAX_KEY_LENGTH) return MALFORMED;
  return value;
}

// Key authentication for the read surface: verify the bearer, attach the row
// and the owner as the read-only viewer, redact the header so no downstream
// code (or log path) can ever see the key, and track usage throttled to one
// write per minute per key. EVERY failure answers the identical 401
// invalid_key envelope — never reveal which case failed.
function createKeyAuth({ keys, log = () => {}, nowMs = () => Date.now() }) {
  const lastTouch = new Map();

  return async function keyAuth(req, res, next) {
    const presented = parseBearer(req);
    if (presented === QUERY_STRING_KEY) {
      return sendV1Error(
        res,
        v1Error('invalid_key', 'Send the key in the Authorization header, not in the URL.', {
          status: 401,
        }),
      );
    }
    if (!presented) {
      return sendV1Error(
        res,
        v1Error('missing_key', 'An API key is required. Send it as: Authorization: Bearer hm_live_…', {
          status: 401,
        }),
      );
    }
    if (presented === MALFORMED) {
      return sendV1Error(res, v1Error('invalid_key', 'That API key is not valid.', { status: 401 }));
    }

    let row = null;
    try {
      row = await keys.verify(presented);
    } catch (err) {
      console.error('[api-v1] key verify failed', err.message);
      return sendV1Error(res, v1Error('provider_error', 'The request could not be completed.', { status: 502 }));
    }
    if (!row) {
      log({
        event: 'invalid_key',
        // Only a well-formed prefix is logged — a mistyped stranger value is
        // never written anywhere.
        keyPrefix: String(presented).startsWith('hm_live_') ? String(presented).slice(0, 12) : 'unrecognized',
      });
      return sendV1Error(res, v1Error('invalid_key', 'That API key is not valid.', { status: 401 }));
    }

    // Redact BEFORE any handler runs: nothing downstream can forward or log
    // the key, even by accident.
    delete req.headers.authorization;

    req.v1 = {
      kind: 'key',
      key: row,
      user: { id: String(row.user_id), username: row.username, reviewer: false },
    };

    const last = lastTouch.get(row.id) || 0;
    if (nowMs() - last >= LAST_USED_THROTTLE_MS) {
      lastTouch.set(row.id, nowMs());
      keys.touch(row.id).catch(() => {}); // usage tracking never fails a request
    }
    return next();
  };
}

// Scope enforcement. Every v1 key carries all read scopes today; the check
// exists so a future narrowed credential needs no migration.
function requireScope(scope) {
  return function scopeCheck(req, res, next) {
    const key = req.v1 && req.v1.key;
    if (!key) {
      return sendV1Error(res, v1Error('missing_key', 'An API key is required.', { status: 401 }));
    }
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    if (!scopes.includes(scope)) {
      return sendV1Error(
        res,
        v1Error('insufficient_scope', `This key does not include the ${scope} scope.`, { status: 403 }),
      );
    }
    return next();
  };
}

// Per-key rate limiting. `cost` is the token price (directions: 3). On
// exhaustion the response always carries Retry-After.
function rateLimit(buckets, cost = 1) {
  return function limit(req, res, next) {
    const key = req.v1 && req.v1.key;
    if (!key) {
      return sendV1Error(res, v1Error('missing_key', 'An API key is required.', { status: 401 }));
    }
    const result = buckets.tryTake(String(key.id), cost);
    if (!result.ok) {
      return sendV1Error(
        res,
        v1Error(
          'rate_limited',
          `Too many requests for this key. Retry after ${result.retryAfterSeconds} seconds.`,
          { status: 429, headers: { 'Retry-After': result.retryAfterSeconds } },
        ),
      );
    }
    return next();
  };
}

// Session enforcement for the key-management surface (the app's own screen).
// A bearer API key is NOT a management credential: those routes simply do
// not exist for it (404), so the public API's key can never touch key
// lifecycle. No session at all answers the envelope's 401.
function requireSession() {
  return function sessionCheck(req, res, next) {
    const kind = req.v1 && req.v1.kind;
    if (kind === 'session') return next();
    if (kind === 'key') {
      return sendV1Error(res, v1Error('not_found', 'Unknown API endpoint.', { status: 404 }));
    }
    return sendV1Error(
      res,
      v1Error('missing_key', 'Sign in to manage API keys.', { status: 401 }),
    );
  };
}

module.exports = {
  v1Error,
  sendV1Error,
  createKeyBuckets,
  createSessionVerifier,
  createKeyAuth,
  requireScope,
  rateLimit,
  requireSession,
  parseBearer,
  QUERY_STRING_KEY,
  MALFORMED,
  LAST_USED_THROTTLE_MS,
};
