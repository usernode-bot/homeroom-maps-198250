// Search service — the client-side SearchService's browser-facing half.
//
// Everything state-machine-shaped lives in the import-free core
// (search-session.js, unit-testable under node:test); this module binds it to
// the real browser dependencies: the 250 ms debounce and abort semantics stay
// in the core, here we provide the authenticated fetchers, the
// localStorage-backed recents storage (guarded like the theme preference,
// because a cross-origin frame can refuse storage), and the map-phase
// plumbing. Recents are never sent to the server and never seeded.
import { apiGet } from '../api.js';
import { getState } from '../state.js';
import { t, searchLangParam } from '../i18n/index.js';
import { createTileStore } from './offline-tiles.js';
import { createOfflineSearchService, createWorkerTileIndexReader } from './offline-search.js';
import {
  OFFLINE_SEARCH_STAGE,
  OfflineSearchUnavailableError,
} from './offline-search-capability.js';
import {
  MIN_QUERY_LENGTH,
  DEBOUNCE_MS,
  MAX_RECENTS,
  createSearchSession as createSessionCore,
  sanitizeRecents,
  addRecent,
  requireQuery,
  searchInViewPath,
  searchNearPath,
} from './search-session.js';

export { MIN_QUERY_LENGTH, DEBOUNCE_MS, MAX_RECENTS };

const STORAGE_KEY = 'hm-recent-searches';
const SUGGEST_LIMIT = 8;
const SEARCH_LIMIT = 10;

// Low-level fetches. Kept exported so a later screen (map overlay, POI list)
// can call them without the panel session.
//
// Language: the active locale's subtag is sent when it is not English.
// Omitting the param for English keeps the server's resolution (platform
// claim, then Accept-Language, then provider default) exactly as Phase 2
// shipped it, so English results are unchanged; non-English locales get
// provider-localized naming through the param the server already accepts.
function langQuery() {
  const lang = searchLangParam();
  return lang ? `&lang=${encodeURIComponent(lang)}` : '';
}

// ---- offline search (Phase 12B) ----
//
// When the device is offline, or a request fails for a network-class reason,
// the fetchers below answer from the regions already stored in IndexedDB
// instead of the server. `fetch` is never called on that path, so a query
// while offline never leaves the device.
//
// `navigator.onLine === false` is the browser's own signal; an explicit
// `?offline=1` / `?offline=0` deep link overrides it (read from the URL query
// or the query after the hash, the way screens/home.js reads ?map=). The
// override is a pure UI state used by the staging demo and by the declared
// checks; it writes nothing.
export function isOffline() {
  const override = offlineUrlOverride();
  if (override != null) return override;
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// Read a 0/1 style deep-link flag from the URL query or the query after the
// hash (this app hash-routes; screens/home.js reads ?map= the same way).
function flagParam(name) {
  try {
    let value = new URLSearchParams(window.location.search).get(name);
    if (value == null) {
      const hash = window.location.hash.replace(/^#/, '');
      const q = hash.indexOf('?');
      if (q >= 0) value = new URLSearchParams(hash.slice(q + 1)).get(name);
    }
    if (value === '1') return true;
    if (value === '0') return false;
    return null;
  } catch {
    return null;
  }
}

// The `?seed=1` flag, read by the boot code to seed the staging demo region.
export function seedUrlOverride() {
  return flagParam('seed');
}

// The `?q=` deep link: a boot-time query the Home screen runs once its search
// session exists, so a URL can land directly on the results state (used by the
// declared checks and the before/after shots). Returns the trimmed value or
// null; it is query STRING only, never a fabricated result.
export function bootQuery() {
  try {
    let value = new URLSearchParams(window.location.search).get('q');
    if (value == null) {
      const hash = window.location.hash.replace(/^#/, '');
      const q = hash.indexOf('?');
      if (q >= 0) value = new URLSearchParams(hash.slice(q + 1)).get('q');
    }
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

// The raw `?offline=` deep-link value: true, false or null (absent). A pure UI
// override of the browser's own onLine signal, used by the declared checks and
// the staging preview to force the offline path deterministically.
export function offlineUrlOverride() {
  return flagParam('offline');
}

// A network-class failure: the fetch itself rejected. An HTTP error is NOT
// one (the server answered), and an abort is the caller's own doing; the
// session's online error path stays untouched for both.
function isNetworkFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false;
  if (err.status && err.status > 0) return false;
  return err.code === 'network_error' || err.name === 'TypeError' || err.name === 'NetworkError';
}

// The map center the active region is chosen from, when a screen has a live
// map. Null (Discover, or before the map is ready) means the most recently
// completed region, which is the documented fallback.
let offlineCenter = null;
export function setOfflineSearchCenter(center) {
  offlineCenter = center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lon))
    ? { lat: Number(center.lat), lon: Number(center.lon) }
    : null;
}

// The scope of the most recent offline query, so the panel can name the area
// in the empty state. Cleared as soon as an online query runs, so an online
// empty result never picks up offline copy.
let lastOfflineScope = null;
export function offlineScope() {
  return lastOfflineScope;
}

let offlineService = null;

// The singleton offline search service. Built lazily so importing this module
// on a device without IndexedDB is safe; returns null when the device cannot
// hold offline data (the caller then reports `unsupported_browser`).
export function getOfflineSearchService() {
  if (offlineService) return offlineService;
  if (typeof indexedDB === 'undefined') return null;
  try {
    offlineService = createOfflineSearchService({
      store: createTileStore({}),
      configProvider: () => getState().config || null,
      labelFor: kindLabel,
      // The browser builds a region's index in the module worker when it can,
      // and on the chunked main-thread path when it cannot. Either way the
      // same pure builder runs.
      buildIndex: createWorkerTileIndexReader(),
    });
  } catch {
    return null;
  }
  return offlineService;
}

// The kind label the offline result's detail line uses. Reuses the app's
// offline-search kind vocabulary (never the server's label tables), through
// the active locale.
function kindLabel(kindKey) {
  const key = 'offline.searchKind' + kindKey.charAt(0).toUpperCase() + kindKey.slice(1);
  const label = t(key);
  return label === key ? null : label;
}

async function offlineAnswer(mode, q, { signal, limit } = {}) {
  if (signal && signal.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
  const service = getOfflineSearchService();
  if (!service) throw new OfflineSearchUnavailableError(OFFLINE_SEARCH_STAGE.UNSUPPORTED_BROWSER);
  // The active region is chosen once here and reused for the query, so the
  // scope line names exactly the region the results came from.
  const region = await service.activeRegion({ center: offlineCenter });
  const results = mode === 'suggest'
    ? await service.suggest(q, { limit, center: offlineCenter })
    : await service.search(q, { limit, center: offlineCenter });
  lastOfflineScope = region
    ? { regionId: region.id, regionName: region.name, attribution: region.attribution || null }
    : null;
  return results;
}

async function onlineAnswer(mode, q, { signal, limit }) {
  lastOfflineScope = null;
  const path = mode === 'suggest'
    ? `/api/search/suggest?q=${encodeURIComponent(q)}&limit=${limit}${langQuery()}`
    : `/api/search?q=${encodeURIComponent(q)}&limit=${limit}${langQuery()}`;
  const body = await apiGet(path, { signal });
  return Array.isArray(body && body.results) ? body.results : [];
}

// Offline first when the device says so. Otherwise the online answer is
// attempted, and only a genuine network-class failure degrades to offline
// (and only when an offline answer exists at all) so a transient outage does
// not mask app errors, rate limits or aborts.
async function answer(mode, q, { signal, limit }) {
  if (isOffline()) return offlineAnswer(mode, q, { signal, limit });
  try {
    return await onlineAnswer(mode, q, { signal, limit });
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    try {
      return await offlineAnswer(mode, q, { signal, limit });
    } catch (offlineErr) {
      if (offlineErr && offlineErr.code === 'offline_unavailable') throw err;
      throw offlineErr;
    }
  }
}

export function fetchSuggest(q, { signal, limit = SUGGEST_LIMIT } = {}) {
  return answer('suggest', q, { signal, limit });
}

export function fetchSearch(q, { signal, limit = SEARCH_LIMIT } = {}) {
  return answer('search', q, { signal, limit });
}

// Map-area and nearby search — the plumbing for the map phase. These are
// standalone calls (no panel session); the UI controls that drive them ship
// with the map, when there is a viewport or a centre to read. An empty term
// is refused client-side with the server's own invalid_query error instead of
// round-tripping a 400.
export async function searchInView(bbox, opts = {}) {
  const q = requireQuery(opts.q);
  const body = await apiGet(searchInViewPath(q, bbox), { signal: opts.signal });
  return Array.isArray(body && body.results) ? body.results : [];
}

export async function searchNear(lat, lon, radiusKm, opts = {}) {
  const q = requireQuery(opts.q);
  const body = await apiGet(searchNearPath(q, lat, lon, radiusKm), { signal: opts.signal });
  return Array.isArray(body && body.results) ? body.results : [];
}

// ---- recent searches (device-local) ----

function readRecents() {
  try {
    return sanitizeRecents(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function writeRecents(recents) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    /* storage refused (some embedded WebViews): recents degrade to session-only */
  }
}

const storage = { read: readRecents, write: writeRecents };

export function listRecentSearches() {
  return readRecents();
}

// Persist a chosen result as a recent search: newest first, deduped by id,
// capped at MAX_RECENTS (the shaping/dedupe logic lives in the core). Returns
// the updated list.
export function addRecentSearch(result) {
  const next = addRecent(readRecents(), result);
  writeRecents(next);
  return next;
}

export function clearRecentSearches() {
  writeRecents([]);
  return [];
}

// The panel session bound to the real fetchers and storage. `overrides` lets
// a caller inject options (e.g. the map-phase onSelect seam) without the
// core, or the fetchers/storage, ever leaking browser globals into tests.
export function createSearchSession(overrides = {}) {
  return createSessionCore({
    fetchers: { suggest: fetchSuggest, search: fetchSearch },
    storage,
    ...overrides,
  });
}