// Offline cache policy — the ONE request-eligibility ruleset, shared by the
// service worker (public/sw.js imports it) and the client services.
//
// The service worker is a map-resource-only worker. It may ever respond to a
// request only when ALL of these hold:
//
//   1. the request method is GET,
//   2. the URL is http(s),
//   3. the URL's host is on the allowlist the client registered for the
//      active map source (the style host, the TileJSON hosts and the tile,
//      sprite and glyph hosts the resolved style actually uses),
//   4. the URL is not an application or API path, on any host,
//   5. the URL classifies as a map resource (tile, style or TileJSON
//      metadata, sprite, glyph).
//
// Everything else — every /api/* call on any host, the app shell, the
// vendored renderer, any other origin the allowlist does not name — passes
// through untouched: the worker never calls respondWith for it, so the
// browser's ordinary network path (and its failure when offline) applies.
// There is no runtime cache of API responses anywhere in this app.
//
// Pure module: no browser globals, so node:test drives it directly.

const TILE_PATH = /\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})(?:@(\d+)x)?\.(pbf|mvt|png|webp|jpg|jpeg)$/i;
const GLYPH_PATH = /\/fonts?\/.*\/(\d+)-(\d+)\.pbf$/i;
const SPRITE_PATH = /\/sprite(?:@2x)?\.(json|png)$/i;

// Map resource kinds. 'metadata' covers the style document and any TileJSON
// the style points at: both are small JSON documents on an allowlisted host.
export const RESOURCE_KINDS = ['tile', 'glyph', 'sprite', 'metadata'];

export function isEligibleMethod(method) {
  return method === 'GET';
}

export function isHttpUrl(url) {
  return url.protocol === 'https:' || url.protocol === 'http:';
}

// Hard exclusions that apply regardless of host. The app's own API is never
// eligible: caching an authenticated, user-scoped response would be both a
// correctness bug (stale application data) and a privacy one.
export function isExcludedUrl(url) {
  if (!isHttpUrl(url)) return true;
  return url.pathname.startsWith('/api/');
}

// Classify an URL against the policy's patterns. Returns the kind, or null
// when the URL is not a map resource shape. Does NOT check the allowlist —
// see isMapResourceRequest for the full gate.
//
// Style documents live at arbitrary paths (/styles/liberty), so shape alone
// cannot classify them: the caller passes the exact metadata URLs it knows
// about (the style URL, stored TileJSON URLs) and those match by href. The
// .json suffix still classifies on its own, since TileJSON paths are .json.
export function classifyMapResource(url, { metadataUrls = [] } = {}) {
  if (isExcludedUrl(url)) return null;
  const path = url.pathname;
  if (TILE_PATH.test(path)) return 'tile';
  if (GLYPH_PATH.test(path)) return 'glyph';
  if (SPRITE_PATH.test(path)) return 'sprite';
  if (path.endsWith('.json')) return 'metadata';
  if (metadataUrls.includes(url.href)) return 'metadata';
  return null;
}

// The full gate the service worker applies. `allowedHosts` is the list the
// client computed from the active map config and its resolved style;
// `metadataUrls` is the exact set of style/TileJSON URLs known to the
// client or stored in the region store. Returns the resource kind when the
// request is eligible, and false when it is not — the worker responds only
// for a truthy kind and passes everything else through untouched.
export function isMapResourceRequest(url, { method = 'GET', allowedHosts = [], metadataUrls = [] } = {}) {
  if (!isEligibleMethod(method)) return false;
  const kind = classifyMapResource(url, { metadataUrls });
  if (!kind) return false;
  const hosts = allowedHosts.map((host) => String(host).toLowerCase());
  if (!hosts.includes(url.hostname.toLowerCase())) return false;
  return kind;
}

// Build the allowlist for a map config plus the resource URLs its resolved
// style actually references. Style URL origin, every template origin the
// TileJSON advertises, sprite and glyph origins. Never includes an /api/
// path: the host list is origin-only, and isExcludedUrl keeps API paths out
// even when the app origin itself is allowlisted (a self-hosted style case).
export function allowedHostsFor({ styleUrl, tileTemplates = [], spriteUrls = [], glyphTemplates = [] } = {}) {
  const hosts = new Set();
  const add = (value) => {
    try {
      const url = new URL(value);
      if (isHttpUrl(url) && !isExcludedUrl(url)) hosts.add(url.hostname.toLowerCase());
    } catch {
      /* an unusable template is skipped, never added as a blanket allow */
    }
  };
  if (styleUrl) add(styleUrl);
  tileTemplates.forEach(add);
  spriteUrls.forEach(add);
  glyphTemplates.forEach(add);
  return [...hosts];
}

// Parse a tile URL's z/x/y from its path, for the service worker's store
// lookup. Returns { z, x, y } or null. Zooms outside 0–22 are not tile
// coordinates in any web map scheme this app plans, so they never match.
export function parseTilePath(pathname) {
  const match = TILE_PATH.exec(pathname);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (z < 0 || z > 22) return null;
  return { z, x, y };
}

// Content type for a stored resource kind, when the SW serves a hit.
export function contentTypeFor(kind, url) {
  const path = url.pathname.toLowerCase();
  if (kind === 'tile' || kind === 'glyph') {
    if (path.endsWith('.pbf') || path.endsWith('.mvt')) return 'application/vnd.mapbox-vector-tile';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  }
  if (kind === 'sprite') return path.endsWith('.json') ? 'application/json' : 'image/png';
  return 'application/json';
}