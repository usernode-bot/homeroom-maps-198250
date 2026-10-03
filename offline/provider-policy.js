// Tile-provider permission policy — the B2 gate.
//
// Bulk tile downloading stays OFF until the repository itself documents
// caching and download rights for the configured tile provider. Nothing else
// can turn it on: not an environment variable, not a code comment, not a
// provider label. The only accepted evidence is `docs/tile-provider-rights.md`,
// which must name the provider and carry these markers:
//
//   provider: <the MAP_PROVIDER preset name, e.g. maplibre-openfreemap>
//   bulk-download: permitted
//   evidence: <a URL to the provider's own terms, licence page or a signed
//              agreement establishing the right to bulk-download and
//              persist its tiles>
//
// The file is read on every resolution (it is a few kilobytes, once per
// /api/config) so adding the documentation is itself the switch: no redeploy
// gate other than the docs, and no way for the gate to go stale against a
// config change. If the configured provider changes, the doc must name the
// new provider or downloads stay blocked.
//
// With the current configuration (OpenFreeMap) no such documentation exists,
// so this module resolves `permitted: false, blocker: 'B2'` and every
// download path in the app reports the honest blocked state.
'use strict';

const fs = require('fs');
const path = require('path');

const RIGHTS_DOC_PATH = path.join(__dirname, '..', 'docs', 'tile-provider-rights.md');

// Resolve the provider's documented rights. Dependency-injected for tests:
// the real call reads the repository's docs directory.
function resolveProviderRights(
  providerName,
  { docPath = RIGHTS_DOC_PATH, readFileSync = fs.readFileSync } = {},
) {
  const provider = String(providerName || '').trim();
  if (!provider) {
    return {
      permitted: false,
      blocker: 'B2',
      reason: 'No map provider is configured, so there is no tile source to document.',
      evidence: null,
    };
  }

  let doc = null;
  try {
    doc = readFileSync(docPath, 'utf8');
  } catch {
    return {
      permitted: false,
      blocker: 'B2',
      reason:
        `The repository does not document bulk download rights for ${provider}. ` +
        'Bulk tile downloading stays disabled until docs/tile-provider-rights.md establishes them.',
      evidence: null,
    };
  }

  // All three markers must be present. A doc that names a different provider,
  // asserts a right without evidence, or cites evidence without the explicit
  // permission line does not unlock anything.
  const providerLine = new RegExp(`^provider:\\s*${provider}\\s*$`, 'im').test(doc);
  const permissionLine = /^bulk-download:\s*permitted\s*$/im.test(doc);
  const evidenceLine = doc.match(/^evidence:\s*(\S.*)$/im);

  if (!providerLine) {
    return {
      permitted: false,
      blocker: 'B2',
      reason: `docs/tile-provider-rights.md does not name the configured provider (${provider}).`,
      evidence: null,
    };
  }
  if (!permissionLine) {
    return {
      permitted: false,
      blocker: 'B2',
      reason: 'docs/tile-provider-rights.md does not carry an explicit "bulk-download: permitted" statement.',
      evidence: null,
    };
  }
  if (!evidenceLine) {
    return {
      permitted: false,
      blocker: 'B2',
      reason: 'docs/tile-provider-rights.md does not cite the evidence for the permission.',
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

module.exports = { resolveProviderRights, RIGHTS_DOC_PATH };