// Community feed core — the pure, import-free state machine behind the
// Community screen's feed. Like search-session.js it imports nothing, and the
// one side effect (fetching a page) is injected, so node:test can drive every
// state (loading, empty, error, retry, paging, stale responses) without a DOM.
//
//   fetchPage(view, { offset, ...params }) -> { items, hasMore, nextOffset }
//   onChange(state)                         optional, called on every change
//
// States: 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'needs_location'.
// Nothing is ever invented: an empty answer is the empty state, a failure the
// error state, and a vote count only changes when the server returns the
// proposal with its new tally (replace()).
'use strict';

export const FEED_VIEWS = [
  { id: 'recent', label: 'Recent' },
  { id: 'popular', label: 'Popular' },
  { id: 'nearby', label: 'Nearby' },
  { id: 'implemented', label: 'Implemented' },
  { id: 'mine', label: 'Yours' },
];

export function isFeedView(id) {
  return FEED_VIEWS.some((v) => v.id === id);
}

function initialState() {
  return {
    view: 'recent',
    params: {},
    status: 'idle',
    items: [],
    hasMore: false,
    nextOffset: null,
    error: null,
    loadingMore: false,
    moreError: null,
  };
}

export function createFeed({ fetchPage, onChange } = {}) {
  if (typeof fetchPage !== 'function') throw new Error('createFeed needs fetchPage');
  let state = initialState();
  // Each load bumps the token; a response for an older token is stale (the
  // person switched views meanwhile) and is dropped.
  let token = 0;

  function set(patch) {
    state = { ...state, ...patch };
    if (onChange) onChange(state);
  }

  async function load(view, params = {}) {
    const mine = ++token;
    set({ ...initialState(), view, params, status: 'loading' });
    try {
      const page = await fetchPage(view, { ...params, offset: 0 });
      if (mine !== token) return;
      const items = Array.isArray(page && page.items) ? page.items : [];
      set({
        status: items.length ? 'ready' : 'empty',
        items,
        hasMore: Boolean(page && page.hasMore),
        nextOffset: page && page.nextOffset != null ? page.nextOffset : null,
      });
    } catch (err) {
      if (mine !== token) return;
      set({ status: 'error', error: err });
    }
  }

  // Nearby before a location is known: no request, an explicit state.
  function needLocation(view) {
    token += 1;
    set({ ...initialState(), view, status: 'needs_location' });
  }

  async function loadMore() {
    if (state.status !== 'ready' || !state.hasMore || state.loadingMore) return;
    const mine = token;
    set({ loadingMore: true, moreError: null });
    try {
      const page = await fetchPage(state.view, { ...state.params, offset: state.nextOffset });
      if (mine !== token) return;
      const seen = new Set(state.items.map((p) => p.id));
      const fresh = (Array.isArray(page && page.items) ? page.items : []).filter((p) => !seen.has(p.id));
      set({
        loadingMore: false,
        items: state.items.concat(fresh),
        hasMore: Boolean(page && page.hasMore),
        nextOffset: page && page.nextOffset != null ? page.nextOffset : null,
      });
    } catch (err) {
      if (mine !== token) return;
      set({ loadingMore: false, moreError: err });
    }
  }

  function retry() {
    return load(state.view, state.params);
  }

  // Swap in the server's latest copy of one proposal (after a vote, an edit
  // or a status move). Unknown ids are ignored: the next load picks them up.
  function replace(proposal) {
    if (!proposal || !state.items.some((p) => p.id === proposal.id)) return;
    set({ items: state.items.map((p) => (p.id === proposal.id ? proposal : p)) });
  }

  return {
    load,
    loadMore,
    retry,
    replace,
    needLocation,
    getState: () => state,
  };
}

// What tapping a vote button means, given the person's current vote:
// the same direction again withdraws it, anything else casts or changes it.
export function voteRequest(currentVote, pressed) {
  if (pressed !== 1 && pressed !== -1) throw new Error('A vote is 1 or -1');
  return currentVote === pressed ? { method: 'DELETE' } : { method: 'PUT', value: pressed };
}

// Feed URL for a view. Nearby carries the centre; other views ignore it.
export function feedPath(view, { offset = 0, limit = 20, near = null, radiusKm = null } = {}) {
  const q = new URLSearchParams({ view, offset: String(offset), limit: String(limit) });
  if (view === 'nearby' && near) {
    q.set('near', `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`);
    if (radiusKm) q.set('radius', String(radiusKm));
  }
  return `/api/community/proposals?${q.toString()}`;
}
