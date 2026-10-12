// Transit-provider permission policy — the PT1 gate (Phase 12E, stage 1).
//
// Transit stays OFF until the repository itself documents data rights for the
// configured transit provider. Nothing else can turn it on: not an environment
// variable, not a code comment, not a provider label, not a routing provider's
// own capability flag. The only accepted evidence is
// `docs/transit-provider-rights.md`, which must name the provider and carry
// these markers:
//
//   provider: <the TRANSIT_PROVIDER name>
//   transit-feed: permitted
//   evidence: <a URL to the feed's licence/terms or a signed agreement
//              establishing the right to download, store and display it>
//
// The file is read on every resolution (it is a few kilobytes, once per
// /api/config) so adding the documentation is itself the switch: no redeploy
// gate other than the docs, and no way for the gate to go stale against a
// config change. If the configured provider changes, the doc must name the
// new provider or transit stays blocked.
//
// Deliberately a separate document from the other gates: tile rights
// (docs/tile-provider-rights.md, gate B2) and traffic rights
// (docs/traffic-provider-rights.md, gate T1) can never open the transit gate,
// and vice versa.
//
// With the repository as it is no such documentation exists — there is no
// transit provider, dataset or credential anywhere — so this module resolves
// `permitted: false, blocker: 'PT1'` and every transit path in the app reports
// the honest unavailable state. Nothing here fabricates stops, routes,
// schedules or alerts.
'use strict';

const fs = require('fs');
const path = require('path');

const RIGHTS_DOC_PATH = path.join(__dirname, '..', 'docs', 'transit-provider-rights.md');

// Resolve the provider's documented rights. Dependency-injected for tests:
// the real call reads the repository's docs directory, and never throws.
function resolveTransitProviderRights(
  providerName,
  { docPath = RIGHTS_DOC_PATH, readFileSync = fs.readFileSync } = {},
) {
  const provider = String(providerName || '').trim();
  if (!provider) {
    return {
      permitted: false,
      blocker: 'PT1',
      reason: 'No transit provider is configured, so there is no data source to document.',
      evidence: null,
    };
  }

  let doc = null;
  try {
    doc = readFileSync(docPath, 'utf8');
  } catch {
    return {
      permitted: false,
      blocker: 'PT1',
      reason:
        `The repository does not document transit data rights for ${provider}. ` +
        'Transit stays disabled until docs/transit-provider-rights.md establishes them.',
      evidence: null,
    };
  }

  // All three markers must be present. A doc that names a different provider,
  // asserts a right without evidence, or cites evidence without the explicit
  // permission line does not unlock anything.
  const providerLine = new RegExp(`^provider:\\s*${provider}\\s*$`, 'im').test(doc);
  const permissionLine = /^transit-feed:\s*permitted\s*$/im.test(doc);
  const evidenceLine = doc.match(/^evidence:\s*(\S.*)$/im);

  if (!providerLine) {
    return {
      permitted: false,
      blocker: 'PT1',
      reason: `docs/transit-provider-rights.md does not name the configured provider (${provider}).`,
      evidence: null,
    };
  }
  if (!permissionLine) {
    return {
      permitted: false,
      blocker: 'PT1',
      reason: 'docs/transit-provider-rights.md does not carry an explicit "transit-feed: permitted" statement.',
      evidence: null,
    };
  }
  if (!evidenceLine) {
    return {
      permitted: false,
      blocker: 'PT1',
      reason: 'docs/transit-provider-rights.md does not cite the evidence for the permission.',
      evidence: null,
    };
  }

  return {
    permitted: true,
    blocker: null,
    reason: null,
    evidence: evidenceLine[1].trim(),
  };
}

module.exports = { resolveTransitProviderRights, RIGHTS_DOC_PATH };
