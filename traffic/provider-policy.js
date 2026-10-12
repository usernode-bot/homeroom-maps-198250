// Live-traffic provider permission policy — the T1 gate (Phase 12D).
//
// Live traffic stays OFF until the repository itself documents display rights
// for the configured traffic provider. Nothing else can turn it on: not an
// environment variable, not a code comment, not an adapter's optimistic
// capability flag. The only accepted evidence is
// `docs/traffic-provider-rights.md`, which must name the provider and carry
// these markers:
//
//   provider: <the TRAFFIC_PROVIDER name, e.g. tomtom>
//   live-traffic-feed: permitted
//   evidence: <a URL to the provider's own terms, licence page or a signed
//              agreement establishing the right to fetch and display its
//              live traffic data>
//
// This mirrors offline/provider-policy.js (the B2 tile gate) on purpose, with
// one deliberate difference: the documents are SEPARATE. Map-tile permissions
// do not authorize traffic data — the master spec records that traffic feeds
// are proprietary with their own terms — so a tile-rights document can never
// open this gate.
//
// The file is read on every resolution (a few kilobytes, once per /api/config)
// so adding the documentation is itself the switch. If the configured provider
// changes, the doc must name the new provider or traffic stays blocked.
//
// With the current repository state no such document exists, and no traffic
// provider is chosen (routing is OSRM, which has no live traffic; the map
// provider is OpenFreeMap, which serves tiles only) — so this module resolves
// `permitted: false, blocker: 'T1'` and every traffic surface in the app
// reports the honest unavailable state. See public/js/services/traffic.js for
// the OTHER kind of traffic this app shows: community reports, which are
// never presented as live.
'use strict';

const fs = require('fs');
const path = require('path');

const TRAFFIC_RIGHTS_DOC_PATH = path.join(__dirname, '..', 'docs', 'traffic-provider-rights.md');

// Resolve the provider's documented rights. Dependency-injected for tests:
// the real call reads the repository's docs directory.
function resolveTrafficProviderRights(
  providerName,
  { docPath = TRAFFIC_RIGHTS_DOC_PATH, readFileSync = fs.readFileSync } = {},
) {
  const provider = String(providerName || '').trim();
  if (!provider) {
    return {
      permitted: false,
      blocker: 'T1',
      reason: 'No live traffic provider is configured, so there is no traffic source to authorize.',
      evidence: null,
    };
  }

  let doc = null;
  try {
    doc = readFileSync(docPath, 'utf8');
  } catch {
    return {
      permitted: false,
      blocker: 'T1',
      reason:
        `The repository does not document live traffic rights for ${provider}. ` +
        'Live traffic stays disabled until docs/traffic-provider-rights.md establishes them.',
      evidence: null,
    };
  }

  // All three markers must be present. A doc that names a different provider,
  // asserts a right without evidence, or cites evidence without the explicit
  // permission line does not unlock anything.
  const providerLine = new RegExp(`^provider:\\s*${provider}\\s*$`, 'im').test(doc);
  const permissionLine = /^live-traffic-feed:\s*permitted\s*$/im.test(doc);
  const evidenceLine = doc.match(/^evidence:\s*(\S.*)$/im);

  if (!providerLine) {
    return {
      permitted: false,
      blocker: 'T1',
      reason: `docs/traffic-provider-rights.md does not name the configured traffic provider (${provider}).`,
      evidence: null,
    };
  }
  if (!permissionLine) {
    return {
      permitted: false,
      blocker: 'T1',
      reason: 'docs/traffic-provider-rights.md does not carry an explicit "live-traffic-feed: permitted" statement.',
      evidence: null,
    };
  }
  if (!evidenceLine) {
    return {
      permitted: false,
      blocker: 'T1',
      reason: 'docs/traffic-provider-rights.md does not cite the evidence for the permission.',
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

module.exports = { resolveTrafficProviderRights, TRAFFIC_RIGHTS_DOC_PATH };
