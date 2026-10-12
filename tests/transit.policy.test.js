// The PT1 transit-provider permission gate (Phase 12E, stage 1): fail-closed
// by construction. Every case here is fully dependency-injected — the tests
// never read the repository's real docs directory, and no fake document can
// exist on disk because of a test run.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTransitProviderRights, RIGHTS_DOC_PATH } = require('../transit/provider-policy');

const PROVIDER = 'staging-demo-transit';

// A fake rights document with the three markers, built in memory only.
function rightsDoc(provider, { permission = true, evidence = true } = {}) {
  return [
    '# Transit provider rights',
    '',
    `provider: ${provider}`,
    permission ? 'transit-feed: permitted' : 'transit-feed: blocked',
    evidence ? 'evidence: https://example.com/feed-licence' : '',
    '',
  ].join('\n');
}

function readFromDoc(doc) {
  return () => doc;
}

test('the gate is keyed on docs/transit-provider-rights.md, its own document', () => {
  assert.equal(
    RIGHTS_DOC_PATH,
    require('path').resolve(__dirname, '..', 'docs', 'transit-provider-rights.md'),
  );
  assert.match(RIGHTS_DOC_PATH, /docs[\\/]transit-provider-rights\.md$/);
  // The other gates' documents must never open this gate.
  assert.doesNotMatch(RIGHTS_DOC_PATH, /tile-provider-rights\.md$/);
  assert.doesNotMatch(RIGHTS_DOC_PATH, /traffic-provider-rights\.md$/);
});

test('no provider configured resolves blocked before any document is read', () => {
  let reads = 0;
  const result = resolveTransitProviderRights('', {
    docPath: '/tmp/never-read.md',
    readFileSync: () => { reads += 1; return rightsDoc(PROVIDER); },
  });
  assert.equal(result.permitted, false);
  assert.equal(result.blocker, 'PT1');
  assert.match(result.reason, /No transit provider is configured/);
  assert.equal(result.evidence, null);
  assert.equal(reads, 0, 'the gate must not read a document when nothing is configured');
});

test('a missing rights document resolves blocked, never throws', () => {
  const result = resolveTransitProviderRights(PROVIDER, {
    docPath: '/tmp/does-not-exist.md',
    readFileSync: () => { throw new Error('ENOENT'); },
  });
  assert.equal(result.permitted, false);
  assert.equal(result.blocker, 'PT1');
  assert.match(result.reason, /does not document transit data rights for staging-demo-transit/);
  assert.equal(result.evidence, null);
});

test('a document that names another provider does not unlock anything', () => {
  const result = resolveTransitProviderRights(PROVIDER, {
    docPath: '/tmp/fake.md',
    readFileSync: readFromDoc(rightsDoc('some-other-provider')),
  });
  assert.equal(result.permitted, false);
  assert.equal(result.blocker, 'PT1');
  assert.match(result.reason, /does not name the configured provider/);
});

test('a permission line without the explicit "transit-feed: permitted" wording does not unlock', () => {
  const doc = rightsDoc(PROVIDER, { permission: false });
  const result = resolveTransitProviderRights(PROVIDER, { docPath: '/tmp/fake.md', readFileSync: readFromDoc(doc) });
  assert.equal(result.permitted, false);
  assert.equal(result.blocker, 'PT1');
  assert.match(result.reason, /transit-feed: permitted/);
});

test('a permission asserted without cited evidence does not unlock', () => {
  const doc = rightsDoc(PROVIDER, { evidence: false });
  const result = resolveTransitProviderRights(PROVIDER, { docPath: '/tmp/fake.md', readFileSync: readFromDoc(doc) });
  assert.equal(result.permitted, false);
  assert.equal(result.blocker, 'PT1');
  assert.match(result.reason, /does not cite the evidence/);
});

test('a complete document unlocks the gate and carries the evidence URL', () => {
  const result = resolveTransitProviderRights(PROVIDER, {
    docPath: '/tmp/fake.md',
    readFileSync: readFromDoc(rightsDoc(PROVIDER)),
  });
  assert.equal(result.permitted, true);
  assert.equal(result.blocker, null);
  assert.equal(result.reason, null);
  assert.equal(result.evidence, 'https://example.com/feed-licence');
});

test('markers are line-anchored and case-insensitive, and matched whole', () => {
  // Whole-name match: a provider line for a longer name must not satisfy a
  // shorter configured name.
  const prefixDoc = ['provider: staging-demo-transit-extra', 'transit-feed: permitted', 'evidence: https://x'].join('\n');
  assert.equal(
    resolveTransitProviderRights(PROVIDER, { docPath: '/tmp/fake.md', readFileSync: readFromDoc(prefixDoc) }).permitted,
    false,
  );
  // Mid-sentence mentions do not count; uppercase markers do.
  const noisyDoc = [
    'we discussed transit-feed: permitted in a meeting',
    `PROVIDER: ${PROVIDER}`,
    'TRANSIT-FEED: PERMITTED',
    'EVIDENCE: https://example.com/feed-licence',
  ].join('\n');
  const noisy = resolveTransitProviderRights(PROVIDER, { docPath: '/tmp/fake.md', readFileSync: readFromDoc(noisyDoc) });
  assert.equal(noisy.permitted, true, 'case-insensitive line-anchored markers still match');
  assert.equal(noisy.evidence, 'https://example.com/feed-licence');
});

test('the document is read on every resolution, so adding it is the switch', () => {
  let reads = 0;
  const options = {
    docPath: '/tmp/fake.md',
    readFileSync: () => { reads += 1; return rightsDoc(PROVIDER); },
  };
  resolveTransitProviderRights(PROVIDER, options);
  resolveTransitProviderRights(PROVIDER, options);
  assert.equal(reads, 2);
});
