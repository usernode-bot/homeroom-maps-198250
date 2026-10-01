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
import { searchLangParam } from '../i18n/index.js';
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

export async function fetchSuggest(q, { signal, limit = SUGGEST_LIMIT } = {}) {
  const body = await apiGet(
    `/api/search/suggest?q=${encodeURIComponent(q)}&limit=${limit}${langQuery()}`,
    { signal },
  );
  return Array.isArray(body && body.results) ? body.results : [];
}

export async function fetchSearch(q, { signal, limit = SEARCH_LIMIT } = {}) {
  const body = await apiGet(
    `/api/search?q=${encodeURIComponent(q)}&limit=${limit}${langQuery()}`,
    { signal },
  );
  return Array.isArray(body && body.results) ? body.results : [];
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