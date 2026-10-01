// Search service — the client-side SearchService.
//
// Owns everything about search that is not pixels: the 250 ms debounce, the
// 2-character minimum, aborting the superseded request while typing, a small
// session cache so re-focusing is instant, recent-searches persistence, and
// the state machine the UI renders from (idle -> typing -> loading ->
// results | no-results | error). Screens subscribe and re-render; they never
// call fetch directly.
//
// Results are the server's normalized shape (search/normalize.js); this
// service adds no provider knowledge. It NEVER fabricates a result: an empty
// server answer is the no-results state and a failed request is the error
// state, always.
//
// Recent searches stay on this device (localStorage 'hm-recent-searches'),
// guarded like the theme preference because a cross-origin frame can refuse
// storage. They are never sent to the server and never seeded.
import { apiGet } from '../api.js';

export const MIN_QUERY_LENGTH = 2;
export const DEBOUNCE_MS = 250;
export const MAX_RECENTS = 8;

const STORAGE_KEY = 'hm-recent-searches';
const SUGGEST_LIMIT = 8;
const SEARCH_LIMIT = 10;

// Low-level fetches. Kept exported so a later screen (map overlay, POI list)
// can call them without the panel session.
export async function fetchSuggest(q, { signal, limit = SUGGEST_LIMIT } = {}) {
  const body = await apiGet(
    `/api/search/suggest?q=${encodeURIComponent(q)}&limit=${limit}`,
    { signal },
  );
  return Array.isArray(body && body.results) ? body.results : [];
}

export async function fetchSearch(q, { signal, limit = SEARCH_LIMIT } = {}) {
  const body = await apiGet(
    `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { signal },
  );
  return Array.isArray(body && body.results) ? body.results : [];
}

// Map-area and nearby search — the plumbing for the map phase. These are
// standalone calls (no panel session); the UI controls that drive them ship
// with the map, when there is a viewport or a centre to read.
export async function searchInView(bbox, opts = {}) {
  const body = await apiGet(
    `/api/search?q=${encodeURIComponent(opts.q || '')}&bbox=${bbox.map(Number).join(',')}`,
    { signal: opts.signal },
  );
  return Array.isArray(body && body.results) ? body.results : [];
}

export async function searchNear(lat, lon, radiusKm, opts = {}) {
  const body = await apiGet(
    `/api/search?q=${encodeURIComponent(opts.q || '')}&near=${Number(lat)},${Number(lon)}` +
      (radiusKm ? `&radius=${Number(radiusKm)}` : ''),
    { signal: opts.signal },
  );
  return Array.isArray(body && body.results) ? body.results : [];
}

// ---- recent searches (device-local) ----

function readRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // Drop anything that is not a recognisable stored result.
    return raw.filter(
      (r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string',
    );
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

export function listRecentSearches() {
  return readRecents();
}

// Persist a chosen result as a recent search: newest first, deduped by id,
// capped at MAX_RECENTS. Returns the updated list.
export function addRecentSearch(result) {
  const stored = {
    id: result.id,
    kind: result.kind,
    name: result.name,
    localName: result.localName || null,
    detail: result.detail,
    addressLine: result.addressLine || null,
    lat: result.lat,
    lon: result.lon,
  };
  const next = [stored, ...readRecents().filter((r) => r.id !== stored.id)].slice(
    0,
    MAX_RECENTS,
  );
  writeRecents(next);
  return next;
}

export function clearRecentSearches() {
  writeRecents([]);
  return [];
}

function isAbort(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

// ---- the panel session ----
//
// createSearchSession() returns a small controller the Home screen wires to
// the search bar and results panel. Every state change goes through emit(),
// so the UI is a pure function of the snapshot it passes to update().

export function createSearchSession() {
  let state = {
    open: false, // panel visible
    query: '',
    results: [],
    error: null,
    selected: null, // the chosen place, shown in the Selected place card
    recents: readRecents(),
    highlighted: -1, // keyboard index into results
    pending: false, // a fetch is in flight
    debouncing: false, // keystrokes waiting out the debounce
    searched: false, // the last query completed and returned (possibly empty)
  };

  const listeners = new Set();
  let debounceTimer = null;
  let controller = null;
  let generation = 0; // ignores completions from a superseded query
  let lastRun = null; // { mode, q } for Try again

  function snapshot() {
    return { ...state };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function cancelPending() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (controller) controller.abort();
    controller = null;
  }

  // The phase the UI renders. Derived, never stored: one source of truth.
  function phase() {
    if (state.error) return 'error';
    if (state.pending) return 'loading';
    const len = state.query.trim().length;
    if (len >= MIN_QUERY_LENGTH) {
      if (!state.searched) return 'typing'; // debounce still pending
      return state.results.length ? 'results' : 'no-results';
    }
    return 'recents'; // short/empty input: recent searches or the idle hint
  }

  async function run(mode, q) {
    cancelPending();
    generation += 1;
    const gen = generation;
    controller = new AbortController();
    lastRun = { mode, q };
    state.pending = true;
    state.error = null;
    state.searched = false;
    state.highlighted = -1;
    emit();
    try {
      const results =
        mode === 'suggest'
          ? await fetchSuggest(q, { signal: controller.signal })
          : await fetchSearch(q, { signal: controller.signal });
      if (gen !== generation) return; // a newer query won
      state.pending = false;
      state.searched = true;
      state.results = results;
      emit();
    } catch (err) {
      if (gen !== generation || isAbort(err)) return;
      state.pending = false;
      state.error = err;
      emit();
    }
  }

  function scheduleSuggest() {
    state.debouncing = true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      state.debouncing = false;
      run('suggest', state.query.trim());
    }, DEBOUNCE_MS);
    emit();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: snapshot,
    phase,

    // The user typed. Below the minimum: back to the recents view. At or
    // above it: debounce, then suggest.
    input(value) {
      state.query = value;
      state.open = true; // typing always (re)opens the panel, even after Escape
      cancelPending();
      state.error = null;
      state.searched = false;
      state.highlighted = -1;
      if (value.trim().length < MIN_QUERY_LENGTH) {
        state.results = [];
        state.pending = false;
        emit();
        return;
      }
      scheduleSuggest();
    },

    open() {
      state.open = true;
      emit();
    },

    close() {
      state.open = false;
      emit();
    },

    // Clear the input: back to the recents view, panel stays open.
    clearInput() {
      cancelPending();
      state.query = '';
      state.results = [];
      state.error = null;
      state.pending = false;
      state.searched = false;
      state.highlighted = -1;
      emit();
    },

    // Escape: close the panel and reset, as if cleared.
    escape() {
      this.clearInput();
      state.open = false;
      emit();
    },

    // Enter with no suggestion highlighted: a committed search.
    commit() {
      const q = state.query.trim();
      if (q.length < MIN_QUERY_LENGTH) return;
      run('search', q);
    },

    // Try again after a failure: re-run whatever was last attempted.
    retry() {
      if (!lastRun) return;
      run(lastRun.mode, lastRun.q);
    },

    move(delta) {
      if (!state.results.length) return;
      const max = state.results.length - 1;
      const next = state.highlighted + delta;
      state.highlighted = next < 0 ? max : next > max ? 0 : next;
      emit();
    },

    select(result) {
      if (!result) return;
      state.recents = addRecentSearch(result);
      state.selected = result;
      state.open = false;
      cancelPending();
      state.query = '';
      state.results = [];
      state.error = null;
      state.pending = false;
      state.searched = false;
      state.highlighted = -1;
      emit();
    },

    // Tap a recent search: search for it again as a committed search.
    repeatRecent(recent) {
      if (!recent || !recent.name) return;
      state.query = recent.name;
      this.open();
      run('search', recent.name);
    },

    removeSelected() {
      state.selected = null;
      emit();
    },

    clearRecents() {
      state.recents = clearRecentSearches();
      emit();
    },
  };
}