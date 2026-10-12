// The W1 weather-provider permission gate (Phase 12G).
//
// The sibling of offline/provider-policy.js (the B2 tile-download gate) and
// built exactly the same way, for the same reason: the app must never call a
// weather API on a guess about what its terms allow. There is deliberately
// NO default provider — no weather source is documented as authorized for
// this repository yet — so until an operator both names a provider and
// documents the authorization, every weather request answers an honest
// 501 (not_configured) rather than scraping or fabricating weather data.
//
// The gate reads ONE markdown file, `docs/weather-provider-rights.md`, and
// accepts a provider only when the document carries, at the top level:
//
//   provider: <name>            — the exact provider name to authorize
//   live-data: authorized       — an explicit permission line for live data
//   evidence: <url or note>     — where the right comes from (terms page,
//                                 written permission, licence text)
//
// Everything is matched case-insensitively on its own line. Nothing else in
// the document matters to the gate, so prose cannot accidentally authorize
// anything: the three markers must all be present and must agree.
//
// Returns { permitted, blocker, reason, evidence }:
//   permitted — whether the named provider may be used for live weather data
//   blocker   — null when permitted, else the W1 gate id
//   reason    — a plain-language sentence the 501 response can carry
//   evidence  — the evidence marker's value when a document was read
'use strict';

const fs = require('fs');

const RIGHTS_DOC_PATH = 'docs/weather-provider-rights.md';

function resolveWeatherProviderRights(providerName, { docPath = RIGHTS_DOC_PATH, readFileSync = fs.readFileSync } = {}) {
  if (!providerName) {
    return {
      permitted: false,
      blocker: 'W1',
      reason: 'No weather provider is configured, and no weather source is documented as authorized for this app.',
      evidence: null,
    };
  }
  let doc;
  try {
    doc = readFileSync(docPath, 'utf8');
  } catch {
    return {
      permitted: false,
      blocker: 'W1',
      reason: `No weather-provider rights document was found at ${docPath}, so no provider is authorized.`,
      evidence: null,
    };
  }
  const lines = String(doc).split(/\r?\n/);
  let claimed = null;
  let liveDataAuthorized = false;
  let evidence = null;
  for (const line of lines) {
    let m = line.match(/^provider:\s*(\S.*?)\s*$/i);
    if (m) {
      claimed = m[1];
      continue;
    }
    m = line.match(/^live-data:\s*(\S.*?)\s*$/i);
    if (m && /^authorized$/i.test(m[1])) {
      liveDataAuthorized = true;
      continue;
    }
    m = line.match(/^evidence:\s*(\S.*?)\s*$/i);
    if (m) {
      evidence = m[1];
    }
  }
  if (!claimed || claimed.toLowerCase() !== String(providerName).toLowerCase()) {
    return {
      permitted: false,
      blocker: 'W1',
      reason: `The weather-provider rights document does not authorize "${providerName}" for live data.`,
      evidence,
    };
  }
  if (!liveDataAuthorized) {
    return {
      permitted: false,
      blocker: 'W1',
      reason: `The weather-provider rights document does not carry the "live-data: authorized" permission line for "${providerName}".`,
      evidence,
    };
  }
  if (!evidence) {
    return {
      permitted: false,
      blocker: 'W1',
      reason: 'The weather-provider rights document carries no evidence line naming where the authorization comes from.',
      evidence: null,
    };
  }
  return { permitted: true, blocker: null, reason: null, evidence };
}

module.exports = { resolveWeatherProviderRights, RIGHTS_DOC_PATH };
