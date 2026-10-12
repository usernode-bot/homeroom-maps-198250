// The live-traffic permission gate (Phase 12D, blocker T1): fail-closed by
// construction. The only accepted evidence is docs/traffic-provider-rights.md
// naming the configured provider and carrying all three markers; anything
// else — a missing doc, a different provider, an unevidenced permission —
// leaves live traffic blocked. Mirrors the offline capability tests (B2).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTrafficProviderRights, TRAFFIC_RIGHTS_DOC_PATH } = require('../traffic/provider-policy');

function doc(body) {
  return () => body;
}

const PERMITTED_DOC = [
  '# Traffic provider rights',
  'provider: tomtom',
  'live-traffic-feed: permitted',
  'evidence: https://example.com/terms',
  '',
].join('\n');

test('the gate reads the repository docs directory by default', () => {
  assert.ok(
    TRAFFIC_RIGHTS_DOC_PATH.includes('docs') &&
      TRAFFIC_RIGHTS_DOC_PATH.endsWith('traffic-provider-rights.md'),
    `unexpected default doc path: ${TRAFFIC_RIGHTS_DOC_PATH}`,
  );
});

test('no configured provider is blocked without reading any document', () => {
  const read = () => {
    throw new Error('must not be read');
  };
  for (const name of [undefined, null, '', '   ']) {
    const rights = resolveTrafficProviderRights(name, { readFileSync: read });
    assert.equal(rights.permitted, false);
    assert.equal(rights.blocker, 'T1');
    assert.match(rights.reason, /no traffic source to authorize/i);
    assert.equal(rights.evidence, null);
  }
});

test('a missing rights document is blocked T1, whatever the provider', () => {
  const rights = resolveTrafficProviderRights('tomtom', {
    docPath: '/nonexistent/traffic-provider-rights.md',
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'T1');
  assert.match(rights.reason, /does not document live traffic rights for tomtom/i);
  assert.equal(rights.evidence, null);
});

test('a document naming a different provider does not unlock the gate', () => {
  const rights = resolveTrafficProviderRights('here', { readFileSync: doc(PERMITTED_DOC) });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'T1');
  assert.match(rights.reason, /does not name the configured traffic provider/i);
});

test('a permission line without the evidence line is blocked', () => {
  const rights = resolveTrafficProviderRights('tomtom', {
    readFileSync: doc('provider: tomtom\nlive-traffic-feed: permitted\n'),
  });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'T1');
  assert.match(rights.reason, /does not cite the evidence/i);
});

test('an evidence line without the explicit permission line is blocked', () => {
  const rights = resolveTrafficProviderRights('tomtom', {
    readFileSync: doc('provider: tomtom\nevidence: https://example.com/terms\n'),
  });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'T1');
  assert.match(rights.reason, /live-traffic-feed: permitted/i);
});

test('an ambiguous permission statement is not the explicit permission', () => {
  const rights = resolveTrafficProviderRights('tomtom', {
    readFileSync: doc('provider: tomtom\nlive-traffic-feed: permitted for internal testing only\nevidence: https://x\n'),
  });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'T1');
});

test('all three markers matching the provider resolve permitted with the evidence', () => {
  const rights = resolveTrafficProviderRights('tomtom', { readFileSync: doc(PERMITTED_DOC) });
  assert.equal(rights.permitted, true);
  assert.equal(rights.blocker, null);
  assert.equal(rights.reason, null);
  assert.equal(rights.evidence, 'https://example.com/terms');
});

test('map-tile rights never open the traffic gate', () => {
  // The B2 tile document (if it existed) names bulk-download, not the traffic
  // permission line — the two authorizations are deliberately separate.
  const tileDoc = 'provider: maplibre-openfreemap\nbulk-download: permitted\nevidence: https://x\n';
  const rights = resolveTrafficProviderRights('maplibre-openfreemap', { readFileSync: doc(tileDoc) });
  assert.equal(rights.permitted, false);
  assert.equal(rights.blocker, 'T1');
});
