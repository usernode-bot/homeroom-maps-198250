// Tests for the W1 weather-provider permission gate
// (weather/provider-policy.js) — the weather sibling of the B2 tile-download
// gate in offline/provider-policy.js. Every case feeds the gate an in-memory
// document through the injected readFileSync, so no test touches the
// filesystem for real.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveWeatherProviderRights, RIGHTS_DOC_PATH } = require('../weather/provider-policy');

const read = (doc) => () => doc;

const AUTHORIZED = [
  'Example Weather — rights',
  '',
  'provider: example-weather',
  'live-data: authorized',
  'evidence: https://example.com/weather-terms',
].join('\n');

test('the gate refuses every provider while no rights document exists', () => {
  // The shipped repository state: docs/weather-provider-rights.md is absent,
  // so readFileSync throws for any name, configured or not.
  const fail = () => {
    throw new Error('ENOENT');
  };
  const denied = resolveWeatherProviderRights('example-weather', { readFileSync: fail });
  assert.equal(denied.permitted, false);
  assert.equal(denied.blocker, 'W1');
  assert.match(denied.reason, /No weather-provider rights document/);
  assert.equal(denied.evidence, null);
});

test('the gate refuses the empty provider name without reading anything', () => {
  let reads = 0;
  const denied = resolveWeatherProviderRights('', {
    readFileSync: () => {
      reads += 1;
      return AUTHORIZED;
    },
  });
  assert.equal(denied.permitted, false);
  assert.equal(denied.blocker, 'W1');
  assert.match(denied.reason, /No weather provider is configured/);
  assert.equal(reads, 0);
});

test('the gate authorizes the provider the document names, with its evidence', () => {
  const granted = resolveWeatherProviderRights('example-weather', { readFileSync: read(AUTHORIZED) });
  assert.equal(granted.permitted, true);
  assert.equal(granted.blocker, null);
  assert.equal(granted.reason, null);
  assert.equal(granted.evidence, 'https://example.com/weather-terms');
});

test('the gate is case-insensitive on the provider name', () => {
  const granted = resolveWeatherProviderRights('Example-Weather', { readFileSync: read(AUTHORIZED) });
  assert.equal(granted.permitted, true);
});

test('a provider the document does not name is refused', () => {
  const denied = resolveWeatherProviderRights('other-weather', { readFileSync: read(AUTHORIZED) });
  assert.equal(denied.permitted, false);
  assert.equal(denied.blocker, 'W1');
  assert.match(denied.reason, /does not authorize "other-weather"/);
});

test('a document without the explicit live-data permission line is refused', () => {
  const doc = ['provider: example-weather', 'evidence: https://example.com/terms'].join('\n');
  const denied = resolveWeatherProviderRights('example-weather', { readFileSync: read(doc) });
  assert.equal(denied.permitted, false);
  assert.match(denied.reason, /live-data: authorized/);
});

test('a live-data line that says anything but authorized is refused', () => {
  const doc = [
    'provider: example-weather',
    'live-data: authorized for non-commercial use only',
    'evidence: https://example.com/terms',
  ].join('\n');
  const denied = resolveWeatherProviderRights('example-weather', { readFileSync: read(doc) });
  assert.equal(denied.permitted, false);
});

test('a document without an evidence line is refused', () => {
  const doc = ['provider: example-weather', 'live-data: authorized'].join('\n');
  const denied = resolveWeatherProviderRights('example-weather', { readFileSync: read(doc) });
  assert.equal(denied.permitted, false);
  assert.match(denied.reason, /no evidence line/);
});

test('prose mentioning the markers on other lines cannot authorize anything', () => {
  const doc = [
    '# Weather provider rights',
    '',
    'We once considered provider: example-weather in a draft.',
    'Someone wrote "live-data: authorized" in a comment once.',
    'provider: example-weather',
    'evidence: https://example.com/terms',
  ].join('\n');
  // The provider/evidence markers match, but the explicit permission line is
  // missing, so the gate stays shut.
  const denied = resolveWeatherProviderRights('example-weather', { readFileSync: read(doc) });
  assert.equal(denied.permitted, false);
});

test('the gate reads the repository docs directory by default', () => {
  assert.ok(path.isAbsolute(RIGHTS_DOC_PATH));
  assert.equal(RIGHTS_DOC_PATH, path.join(__dirname, '..', 'docs', 'weather-provider-rights.md'));
});

test('the default rights path resolves from a non-repository-root working directory', () => {
  const repoDocs = path.join(__dirname, '..', 'docs');
  const previousCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    // The default path is computed from __dirname at module load, so it must
    // not move with the working directory — the old CWD-relative default did.
    assert.ok(path.isAbsolute(RIGHTS_DOC_PATH));
    assert.equal(RIGHTS_DOC_PATH, path.join(repoDocs, 'weather-provider-rights.md'));
    // The discriminator: a CWD-relative default would resolve to
    // <tmpdir>/docs here, which does not exist; the module-relative one
    // points at the repository's docs directory, which does.
    assert.equal(fs.existsSync(path.dirname(RIGHTS_DOC_PATH)), true);
    // With all defaults (the real readFileSync), the absent document still
    // fails closed from a foreign working directory.
    const denied = resolveWeatherProviderRights('example-weather');
    assert.equal(denied.permitted, false);
    assert.equal(denied.blocker, 'W1');
  } finally {
    process.chdir(previousCwd);
  }
});
