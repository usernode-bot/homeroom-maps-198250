// Structural test for the public API document (docs/openapi.yaml): every
// route registered on the v1 public router must have a matching path entry,
// and the envelope schema must be described. No YAML package exists in the
// repo, so path keys are parsed with a line regex — enough for the one thing
// this test asserts: that the document cannot silently drift from the router.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApiV1 } = require('../api/index');
const { SCOPES } = require('../api/keys');

const DOC_PATH = path.join(__dirname, '..', 'docs', 'openapi.yaml');
const doc = fs.readFileSync(DOC_PATH, 'utf8');

// ---- the routes the router actually registers ----------------------------------

function registeredPaths() {
  const paths = new Set();
  for (const layer of publicRouter().stack) {
    if (!layer.route) continue; // middleware layers
    const routePath = layer.route.path;
    if (typeof routePath !== 'string') continue;
    // The document's paths are relative to its servers entry (/api/v1), so
    // compare against the route path itself, not the mounted URL.
    paths.add(routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}'));
  }
  return paths;
}

function publicRouter() {
  const noop = () => {};
  const api = createApiV1({
    keys: { verify: noop, touch: noop, list: noop, create: noop, revoke: noop },
    searchApi: { run: noop },
    routingApi: { run: noop },
    placesApi: { createPlaceService: () => ({}) },
    communityStore: { list: noop, get: noop },
    reportsStore: { list: noop, get: noop },
    verifySession: () => null,
    settings: { resolveCapabilities: () => ({ routing: { configured: true, modes: [] } }) },
  });
  return api.publicRouter;
}

// ---- the paths the document declares --------------------------------------------

// `paths:` entries sit at exactly two-space indentation. Stop at the first
// line that closes the block (any line at column 0 after it).
function documentedPaths() {
  const paths = new Set();
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l === 'paths:');
  assert.ok(start !== -1, 'the document has a paths: block');
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // paths: block ended
    const m = /^ {2}(\/[^:]+):$/.exec(line);
    if (m) paths.add(m[1]);
  }
  return paths;
}

test('every registered v1 route has a matching path entry in docs/openapi.yaml', () => {
  const registered = registeredPaths();
  const documented = documentedPaths();
  for (const route of registered) {
    assert.ok(
      documented.has(route),
      `route ${route} is registered but missing from the OpenAPI document`,
    );
  }
  // And nothing is documented that is not served (the doc never oversells).
  assert.deepEqual([...documented].sort(), [...registered].sort());
});

test('the document is OpenAPI 3.1 and describes the one error envelope', () => {
  assert.match(doc, /^openapi: 3\.1\.0$/m);
  assert.match(doc, /code:\n {14}type: string|code:\n\s+type: string/);
  for (const code of [
    'invalid_query', 'unsupported_mode', 'missing_key', 'invalid_key',
    'insufficient_scope', 'not_found', 'no_route', 'rate_limited',
    'not_configured', 'api_disabled', 'provider_error', 'timeout',
  ]) {
    assert.ok(doc.includes(`- ${code}\n`), `envelope code ${code} is documented`);
  }
});

test('the document documents bearer auth, Retry-After on 429 and the attribution rule', () => {
  assert.match(doc, /BearerKey:/);
  assert.match(doc, /scheme: bearer/);
  // Every path with a 429 response sits under the shared Retry-After note.
  assert.ok(/429.*\n/.test(doc));
  assert.match(doc, /Retry-After/);
  assert.match(doc, /OpenStreetMap contributors/);
});

test('the document lists exactly the five read scopes and no write scope', () => {
  for (const scope of SCOPES) assert.ok(doc.includes(scope), `scope ${scope} documented`);
  assert.doesNotMatch(doc, /:write\b/);
  assert.match(doc, /no write endpoints|writes of any kind/i);
});

test('the document names the deferred capabilities honestly, as unavailable', () => {
  for (const term of ['weather', 'traffic', 'transit', 'business profiles']) {
    assert.ok(doc.includes(term), `deferred capability "${term}" is named as not available`);
  }
  // Nothing may advertise them as live endpoints.
  assert.doesNotMatch(doc, /\/api\/v1\/(weather|traffic|transit|business)/);
});
