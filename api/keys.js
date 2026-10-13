// API keys (Phase 12K): the storage and crypto behind the developer API.
//
// A key is created only by a signed-in member through the app's own screen;
// there is no external issuance endpoint. The plaintext key exists exactly
// once — in the creation response — and never again: the table stores only a
// SHA-256 hash, so a database copy cannot hand anyone a working credential.
//
// The table is credential material, so it is marked `staging:private` (the
// platform copies schema only into staging) and staging seeds one obviously
// fake demo row owned by a fake identity, never the visitor.
'use strict';

const crypto = require('crypto');

const KEY_PREFIX = 'hm_live_';
const KEY_BYTES = 32;
const PREFIX_CHARS = 12; // 'hm_live_' plus 4 key characters — list display + log correlation
const MAX_NAME_LENGTH = 60;

// Every v1 key carries all the read scopes. The enforcement middleware exists
// from day one so a future narrowing needs no credential migration.
const SCOPES = ['search:read', 'routing:read', 'places:read', 'community:read', 'reports:read'];

// Typed error for the management surface. Same shape as the typed errors the
// domain services throw; the v1 router maps the code onto its envelope.
function keyError(code, message, { status = 400, fields } = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (fields) err.fields = fields;
  return err;
}

// hm_live_ + base64url of 32 random bytes (43 characters) — ~256 bits, URL-
// and header-safe. Returned in full exactly once by create().
function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
}

// The stored form: SHA-256 hex. Lookup is by this hash, so the plaintext is
// never persisted anywhere.
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

// What list display and logs show: the first PREFIX_CHARS characters only.
function keyPrefix(key) {
  return String(key).slice(0, PREFIX_CHARS);
}

// Defense-in-depth: after the hash lookup, re-prove the stored hash really is
// the hash of the presented key with a comparison whose time does not depend
// on where the first differing byte sits.
function hashesMatch(storedHex, presentedHex) {
  const a = Buffer.from(String(storedHex), 'hex');
  const b = Buffer.from(String(presentedHex), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// A name is required, trimmed, and short enough to render in the key list.
function validateName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) {
    throw keyError('invalid_query', 'Give the key a name.', {
      fields: { name: 'A name is required.' },
    });
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw keyError('invalid_query', `Key names are limited to ${MAX_NAME_LENGTH} characters.`, {
      fields: { name: `Use at most ${MAX_NAME_LENGTH} characters.` },
    });
  }
  return name;
}

// Scopes are the fixed read set; unknown scopes are refused rather than
// stored. Every created key carries all of them (see SCOPES).
function validateScopes(raw) {
  const requested = Array.isArray(raw) ? raw : SCOPES;
  const unknown = requested.filter((s) => !SCOPES.includes(s));
  if (unknown.length) {
    throw keyError('invalid_query', `Unknown scope: ${unknown.join(', ')}.`);
  }
  return requested.length ? requested : SCOPES;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
COMMENT ON TABLE api_keys IS 'staging:private';
`;

function createStore({ pool, maxKeysPerUser = 5 }) {
  const cap = Math.max(1, Math.floor(Number(maxKeysPerUser) || 5));

  async function migrate() {
    for (const statement of SCHEMA_SQL.split(';')) {
      const sql = statement.trim();
      if (sql) await pool.query(sql);
    }
  }

  // Staging seed (platform convention): api_keys is staging:private, so its
  // schema reaches staging empty. One obviously-fake row — name "Staging demo
  // key", owner a fake 900001-style identity, NEVER the visitor — lets a
  // reviewer exercise the API itself with the documented demo key. The demo
  // key is deterministic (a hash of a fixed string) so the docs can name it;
  // it opens only read-only map data behind the same rate limit, and the seed
  // runs in staging only.
  const DEMO_KEY =
    KEY_PREFIX +
    crypto.createHash('sha256').update('homeroom-maps staging demo api key').digest().toString('base64url');

  async function seedStaging() {
    if (process.env.USERNODE_ENV !== 'staging') return;
    await pool.query(
      `INSERT INTO api_keys (user_id, username, name, key_hash, key_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (key_hash) DO NOTHING`,
      [900001, 'staging-demo-user', 'Staging demo key', hashKey(DEMO_KEY), keyPrefix(DEMO_KEY), JSON.stringify(SCOPES)],
    );
  }

  // The row shape the management surface returns. Never includes the hash.
  function toApi(row) {
    return {
      id: String(row.id),
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      lastUsedAt: row.last_used_at
        ? row.last_used_at instanceof Date
          ? row.last_used_at.toISOString()
          : row.last_used_at
        : null,
      revokedAt: row.revoked_at
        ? row.revoked_at instanceof Date
          ? row.revoked_at.toISOString()
          : row.revoked_at
        : null,
    };
  }

  // Create a key for a signed-in person. Enforces the per-person cap over
  // ACTIVE keys only — revoking frees a slot, which is how rotation works.
  async function create({ user, name, scopes }) {
    const cleanName = validateName(name);
    const cleanScopes = validateScopes(scopes);
    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    );
    if (countRows[0].n >= cap) {
      throw keyError(
        'key_limit',
        `You already have the maximum of ${cap} API keys. Revoke one first.`,
      );
    }
    const key = generateKey();
    const { rows } = await pool.query(
      `INSERT INTO api_keys (user_id, username, name, key_hash, key_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [user.id, user.username, cleanName, hashKey(key), keyPrefix(key), JSON.stringify(cleanScopes)],
    );
    // The ONLY place the plaintext key is ever returned.
    return { key, record: toApi(rows[0]) };
  }

  async function list(user) {
    const { rows } = await pool.query(
      `SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [user.id],
    );
    return rows.map(toApi);
  }

  // The person's own keys only; another person's id is not_found, exactly
  // like every other owner-scoped route in this app.
  async function revoke(user, rawId) {
    const id = Number.parseInt(rawId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw keyError('not_found', 'That key does not exist.', { status: 404 });
    }
    const { rows } = await pool.query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [id, user.id],
    );
    if (!rows[0]) {
      throw keyError('not_found', 'That key does not exist.', { status: 404 });
    }
    return { revoked: true, id: String(rows[0].id) };
  }

  // Verify a presented bearer key. Every failure returns null — the middleware
  // answers one uniform 401, so nothing about a key's state can be probed.
  async function verify(presented) {
    if (typeof presented !== 'string' || !presented.startsWith(KEY_PREFIX)) return null;
    const hash = hashKey(presented);
    const { rows } = await pool.query('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    const row = rows[0];
    if (!row) return null;
    if (!hashesMatch(row.key_hash, hash)) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  }

  // Usage tracking, throttled by the caller (one write per minute per key at
  // most) so a burst does not become a write per request.
  async function touch(id) {
    await pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
  }

  return { migrate, seedStaging, create, list, revoke, verify, touch };
}

module.exports = {
  KEY_PREFIX,
  SCOPES,
  MAX_NAME_LENGTH,
  keyError,
  generateKey,
  hashKey,
  keyPrefix,
  hashesMatch,
  validateName,
  validateScopes,
  SCHEMA_SQL,
  createStore,
};
