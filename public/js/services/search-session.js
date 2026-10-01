// Search session core — the pure, import-free state machine behind the search
// panel. Extracted from services/search.js so node:test can drive every
// required behavior (empty query, typos, no results, failures, stale
// responses, selection) without a DOM: this module imports nothing, and every
// side-effectful dependency is injected.
//
//   fetchers: { suggest(q, {signal}), search(q, {signal}) }   required
//   storage:  { read() -> raw list, write(list) }             optional —
//             absent means recents are session-only (also how a refused
//             localStorage degrades, see services/search.js)
//   onSelect: callback(result)                                optional seam for
//             the map phase (focus + marker); failures never break selection
//   debounceMs: override for tests (default DEBOUNCE_MS)
//
// Results are the server's normalized shape (search/normalize.js); nothing
// here adds provider knowledge and nothing is ever fabricated: an empty
// answer is the no-results state, a failed request the error state, always.
'use strict';

export const MIN_QUERY_LENGTH = 2;
export const DEBOUNCE_MS = 250;
export const MAX_RECENTS = 8;

// The client-side twin of the server's invalid_query: thrown before a request
// is made when the caller (e.g. a map-area search) would send an empty term.
export class InvalidQueryError extends Error {
  constructor(message = 'Enter a search term.') {
    super(message);
    this.name = 'InvalidQueryError';
    this.code = 'invalid_query';
  }
}

export function requireQuery(q) {
  const trimmed = typeof q === 'string' ? q.trim() : '';
  if (!trimmed) throw new InvalidQueryError();
  return trimmed;
}

// URL builders for the map-area and nearby plumbing (services/search.js calls
// these with the real fetcher). Pure so the shapes are testable in isolation.
export function searchInViewPath(q, bbox) {
  return `/api/search?q=${encodeURIComponent(requireQuery(q))}&bbox=${bbox.map(Number).join(',')}`;
}

export function searchNearPath(q, lat, lon, radiusKm) {
  return `/api/search?q=${encodeURIComponent(requireQuery(q))}&near=${Number(lat)},${Number(lon)}` +
    (radiusKm ? `&radius=${Number(radiusKm)}` : '');
}

// ---- recent searches (pure helpers; persistence is the injected storage) ----

// Drop anything that is not a recognisable stored result.
export function sanitizeRecents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string',
  );
}

// What a chosen result keeps when it becomes a recent search.
export function storedRecent(result) {
  return {
    id: result.id,
    kind: result.kind,
    name: result.name,
    localName: result.localName || null,
    detail: result.detail,
    addressLine: result.addressLine || null,
    lat: result.lat,
    lon: result.lon,
  };
}

// Newest first, deduped by id, capped at MAX_RECENTS.
export function addRecent(recents, result) {
  const stored = storedRecent(result);
  return [stored, ...recents.filter((r) => r.id !== stored.id)].slice(0, MAX_RECENTS);
}

// ---- the panel session ----
//
// createSearchSession() returns a small controller the Home screen wires to
// the search bar and results panel. Every state change goes through emit(),
// so the UI is a pure function of the snapshot it passes to update().

export function createSearchSession({
  fetchers,
  storage = null,
  onSelect = null,
  debounceMs = DEBOUNCE_MS,
} = {}) {
  if (!fetchers || !fetchers.suggest || !fetchers.search) {
    throw new Error('createSearchSession needs suggest and search fetchers.');
  }

  let state = {
    open: false, // panel visible
    query: '',
    results: [],
    error: null,
    selected: null, // the chosen place, shown in the Selected place card
    recents: storage ? sanitizeRecents(storage.read()) : [],
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
      const fetcher = mode === 'suggest' ? fetchers.suggest : fetchers.search;
      const results = await fetcher(q, { signal: controller.signal });
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

  function isAbort(err) {
    return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
  }

  function scheduleSuggest() {
    state.debouncing = true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      state.debouncing = false;
      run('suggest', state.query.trim());
    }, debounceMs);
    emit();
  }

  // Persist through the injected storage. A refused write (some embedded
// WebViews refuse localStorage) degrades to session-only recents rather than
// breaking the selection flow.
function persistRecents() {
    if (!storage) return;
    try {
      storage.write(state.recents);
    } catch {
      /* storage refused: recents stay in-session */
    }
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
      state.recents = addRecent(state.recents, result);
      persistRecents();
      state.selected = result;
      state.open = false;
      cancelPending();
      state.query = '';
      state.results = [];
      state.error = null;
      state.pending = false;
      state.searched = false;
      state.highlighted = -1;
      if (onSelect) {
        try {
          onSelect(result);
        } catch (err) {
          console.error(err);
        }
      }
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
      state.recents = [];
      persistRecents();
      emit();
    },
  };
}