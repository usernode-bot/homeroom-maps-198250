// Homeroom Maps service worker — MAP RESOURCES ONLY.
//
// Scope and purpose: when offline map areas are supported (Phase 12A) and a
// region has been downloaded, this worker serves that region's stored tiles,
// sprites, glyphs and style/TileJSON metadata from IndexedDB so an already
// open map keeps rendering without a network connection.
//
// What this worker will NEVER touch:
//   - any request whose method is not GET,
//   - any /api/* path on any host (application and platform API responses
//     are never cached, stored or served by this worker),
//   - the app shell, its scripts, its stylesheet or the vendored renderer,
//   - any host that is not backed by stored region data (a manifest's style
//     URL or a stored resource URL) and has not been announced by the client.
//
// Everything outside the policy passes through with no respondWith call, so
// the browser's ordinary network path applies unchanged. There is no Cache
// Storage API use here and no API-response cache anywhere in this app: the
// only persistence is the offline tile store (IndexedDB) written by the
// download orchestrator, and its contents are exactly what a completed
// region verified.
//
// The eligibility ruleset is offline-cache-policy.js — the same module the
// client uses — so the worker cannot drift from what the client considers a
// map resource.

import { isMapResourceRequest, parseTilePath, contentTypeFor } from '/js/services/offline-cache-policy.js';
import { createTileStore } from '/js/services/offline-tiles.js';

// Hosts the client announced for the active map source. Empty until announced;
// nothing at all is eligible before that.
let allowedHosts = [];
let metadataUrls = [];
let regionsCache = [];
let storePromise = null;

function tileStore() {
  if (!storePromise) storePromise = createTileStore({}).ready();
  return storePromise;
}

// The eligibility set is derived from what is actually stored: each manifest's
// style URL plus every stored resource URL (TileJSONs, sprites, glyphs — the
// documents whose hosts also serve the tiles). The client's announcement is
// merged on top. Nothing here widens the policy: an announced host still has
// to classify as a map resource, and /api/* is excluded regardless.
function addHost(hosts, value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      hosts.add(url.hostname.toLowerCase());
    }
  } catch {
    /* an unusable stored value contributes nothing */
  }
}

// Metadata resources (style documents, TileJSONs) live at arbitrary paths,
// so the policy matches them by exact href rather than by shape.
function addHref(hrefs, value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      hrefs.add(url.href);
    }
  } catch {
    /* an unusable stored value contributes nothing */
  }
}

async function refreshRegions() {
  try {
    const store = await tileStore();
    const regions = await store.listRegions();
    const hosts = new Set(allowedHosts);
    const hrefs = new Set(metadataUrls);
    for (const region of regions) {
      addHost(hosts, region && region.styleUrl);
      addHref(hrefs, region && region.styleUrl);
      try {
        const urls = await store.listResourceUrls(region.id);
        for (const url of urls) {
          addHost(hosts, url);
          addHref(hrefs, url);
        }
      } catch {
        /* a region whose resources cannot be read contributes its style only */
      }
    }
    regionsCache = regions;
    allowedHosts = [...hosts];
    metadataUrls = [...hrefs];
  } catch {
    regionsCache = [];
  }
}

// The offline hit: serve the stored bytes with the content type the URL
// shape implies. A miss is NOT an error: it falls back to the network, which
// is exactly the "offline cache miss" the spec describes.
async function serve(request, url, kind) {
  const store = await tileStore();
  const tile = parseTilePath(url.pathname);
  const hit = tile
    ? await store.findTile(tile, regionsCache)
    : await store.findResource(url.href, regionsCache);
  if (hit && hit.data) {
    return new Response(hit.data, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(kind, url),
        'x-homeroom-offline': 'region-store',
      },
    });
  }
  return fetch(request);
}

if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        await self.clients.claim();
        await refreshRegions();
      })(),
    );
  });

  self.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'offline:allowed-hosts' && Array.isArray(data.hosts)) {
      allowedHosts = data.hosts.map((host) => String(host).toLowerCase());
      event.waitUntil(refreshRegions());
    }
    if (data.type === 'offline:refresh-regions') {
      event.waitUntil(refreshRegions());
    }
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    // The single policy gate. Anything not classified as a map resource on
    // an announced host returns here: the worker never calls respondWith
    // for it, so API calls, the shell and every other request keep their
    // ordinary network behaviour, online or off.
    const kind = isMapResourceRequest(url, {
      method: request.method,
      allowedHosts,
      metadataUrls,
    });
    if (!kind) return;
    event.respondWith(serve(request, url, kind));
  });
}

// Exported for tests only: the module's own state is otherwise private.
export const __test = { refreshRegions };