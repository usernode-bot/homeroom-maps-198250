// Unit tests for the API-key crypto and validation (api/keys.js). All
// synchronous, no database: the store itself is covered by
// tests/api.postgres.test.js against a real Postgres.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../api/keys');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null; // did not throw
}

test('key format: hm_live_ plus 43 base64url characters (~256 bits)', () => {
  const key = generateKey();
  assert.match(key, /^hm_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.length, 51);
  // Two generated keys never collide.
  assert.notEqual(key, generateKey());
});

test('hashKey is a 64-character SHA-256 hex digest and is deterministic', () => {
  const h = hashKey('hm_live_abc');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashKey('hm_live_abc'));
  assert.notEqual(h, hashKey('hm_live_abd'));
});

test('keyPrefix keeps the display prefix only', () => {
  assert.equal(keyPrefix('hm_live_ABCDEFGHIJKLMNOP'), 'hm_live_ABCD');
  assert.equal(keyPrefix('hm_live_ABCDEFGHIJKLMNOP').length, 12);
});

test('hashesMatch is constant-time-equal and refuses length mismatches', () => {
  const h = hashKey('hm_live_abc');
  assert.equal(hashesMatch(h, h), true);
  assert.equal(hashesMatch(h, hashKey('hm_live_abd')), false);
  assert.equal(hashesMatch(h, 'not-hex'), false);
  assert.equal(hashesMatch('', h), false);
  assert.equal(hashesMatch(h, ''), false);
});

test('validateName trims, accepts, and refuses empty and overlong names', () => {
  assert.equal(validateName('  My integration  '), 'My integration');
  assert.equal(codeOf(() => validateName('')), 'invalid_query');
  assert.equal(codeOf(() => validateName('   ')), 'invalid_query');
  assert.equal(codeOf(() => validateName(null)), 'invalid_query');
  assert.equal(validateName('x'.repeat(MAX_NAME_LENGTH)), 'x'.repeat(MAX_NAME_LENGTH));
  assert.equal(codeOf(() => validateName('x'.repeat(MAX_NAME_LENGTH + 1))), 'invalid_query');
});

test('validateName errors carry a field, so the screen can mark the input', () => {
  try {
    validateName('');
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'invalid_query');
    assert.ok(err.fields && err.fields.name);
  }
});

test('validateScopes defaults to the full read set and refuses unknown scopes', () => {
  assert.deepEqual(validateScopes(undefined), SCOPES);
  assert.deepEqual(validateScopes(['search:read']), ['search:read']);
  assert.equal(codeOf(() => validateScopes(['write:everything'])), 'invalid_query');
  assert.equal(codeOf(() => validateScopes(['search:read', 'nope'])), 'invalid_query');
});

test('every v1 key carries all read scopes, and none is a write scope', () => {
  assert.deepEqual(SCOPES, ['search:read', 'routing:read', 'places:read', 'community:read', 'reports:read']);
  for (const scope of SCOPES) assert.match(scope, /:read$/);
});

test('keyError produces the typed error shape the envelope maps', () => {
  const err = keyError('not_found', 'That key does not exist.', { status: 404 });
  assert.equal(err.code, 'not_found');
  assert.equal(err.status, 404);
  assert.equal(err.message, 'That key does not exist.');
  assert.equal(keyError('key_limit', 'Full.').status, 400);
});

test('the schema marks api_keys staging:private and indexes the owner', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS api_keys/);
  assert.match(SCHEMA_SQL, /COMMENT ON TABLE api_keys IS 'staging:private'/);
  assert.match(SCHEMA_SQL, /UNIQUE/); // key_hash unique — lookup by hash
  assert.match(SCHEMA_SQL, /api_keys_user_idx/);
  // The plaintext key is never a column.
  assert.doesNotMatch(SCHEMA_SQL, /key_plaintext|api_key TEXT/);
});
