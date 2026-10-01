// Tests for the client-side search session core (search-session.js) — the
// pure state machine behind the search panel. The module is browser ESM with
// zero imports, loaded here via dynamic import (Node 22 detects the module
// syntax), with fetchers, storage and the debounce injected so no DOM and no
// timers beyond short real sleeps are involved.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// A normalized-shaped result, as the server returns.
function res(id, name) {
  return {
    id,
    kind: 'city',
    name,
    localName: null,
    detail: name,
    address: {},
    addressLine: null,
    lat: 1,
    lon: 2,
    provider: 'photon',
  };
}

// Fake fetchers that record every call; `suggest`/`search` are the stubs.
function fakeFetchers({ suggest = async () => [], search = async () => [] } = {}) {
  const calls = [];
  const wrap = (mode, impl) => async (q, opts) => {
    calls.push({ mode, q, signal: Boolean(opts && opts.signal) });
    return impl(q, opts);
  };
  return {
    fetchers: { suggest: wrap('suggest', suggest), search: wrap('search', search) },
    calls,
  };
}

// Injectable in-memory storage standing in for localStorage.
function memoryStorage() {
  let saved = null;
  return {
    read: () => (saved === null ? [] : JSON.parse(saved)),
    write: (list) => {
      saved = JSON.stringify(list);
    },
    dump: () => saved,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = { debounceMs: 5 };
const waitDebounce = () => sleep(25);

async function makeSession({ storage, onSelect, suggest, search } = {}) {
  const core = await import('../public/js/services/search-session.js');
  const { fetchers, calls } = fakeFetchers({ suggest, search });
  const session = core.createSearchSession({ fetchers, storage, onSelect, ...DEBOUNCE });
  return { core, session, calls };
}

test('input below the minimum returns to the recents view without fetching', async () => {
  const { session, calls } = await makeSession();
  session.input('b');
  await waitDebounce();
  assert.equal(calls.length, 0);
  assert.equal(session.phase(), 'recents');
  assert.equal(session.getState().query, 'b');
  assert.deepEqual(session.getState().results, []);
});

test('debounce fires exactly one suggest call with the trimmed query', async () => {
  const { session, calls } = await makeSession({ suggest: async () => [res('s1', 'Berlin')] });
  session.input('  ber  ');
  await waitDebounce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'suggest');
  assert.equal(calls[0].q, 'ber');
  assert.equal(session.phase(), 'results');
  assert.equal(session.getState().results[0].name, 'Berlin');
});

test('an empty provider answer is the no-results state, never a fallback', async () => {
  const { session } = await makeSession({ suggest: async () => [] });
  session.input('xzqqqjjj');
  await waitDebounce();
  assert.equal(session.phase(), 'no-results');
  assert.deepEqual(session.getState().results, []);
});

test('a failed request is the error state and Try again re-runs the same query', async () => {
  let fail = true;
  const { session, calls } = await makeSession({
    suggest: async () => {
      if (fail) throw new Error('boom');
      return [res('s1', 'Berlin')];
    },
  });
  session.input('ber');
  await waitDebounce();
  assert.equal(session.phase(), 'error');
  assert.equal(session.getState().error.message, 'boom');
  assert.equal(calls.length, 1);
  session.retry();
  await waitDebounce();
  assert.equal(calls.length, 2);
  fail = false;
  session.retry();
  await waitDebounce();
  assert.equal(session.phase(), 'results');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].q, 'ber');
});

test('a stale response never overwrites the newer query, and is not an error', async () => {
  const first = deferred();
  const second = deferred();
  const { session } = await makeSession({
    suggest: (q) => (q === 'be' ? first.promise : second.promise),
  });
  session.input('be');
  await waitDebounce();
  session.input('berlin'); // supersedes 'be'
  await waitDebounce();
  second.resolve([res('berlin-1', 'Berlin')]);
  await sleep(5);
  assert.equal(session.phase(), 'results');
  assert.equal(session.getState().results[0].name, 'Berlin');
  first.resolve([res('be-1', 'Stale')]); // the old query lands late
  await sleep(5);
  assert.equal(session.phase(), 'results');
  assert.equal(session.getState().results[0].name, 'Berlin');
  assert.equal(session.getState().error, null);
});

test('Enter commits a full search; a short query does nothing', async () => {
  const { session, calls } = await makeSession({ search: async () => [res('c1', 'Berlin')] });
  session.input('b');
  session.commit();
  await waitDebounce();
  assert.equal(calls.filter((c) => c.mode === 'search').length, 0);
  session.input('berlin');
  session.commit();
  await waitDebounce();
  assert.equal(calls.filter((c) => c.mode === 'search').length, 1);
  assert.equal(calls[0].q, 'berlin');
  assert.equal(session.phase(), 'results');
});

test('selection stores deduped, capped recents, closes the panel and calls the seam', async () => {
  const seen = [];
  const storage = memoryStorage();
  const { session } = await makeSession({
    storage,
    onSelect: (result) => seen.push(result.id),
  });
  for (let i = 1; i <= 10; i++) session.select(res(`r${i}`, `Place ${i}`));
  session.select(res('r3', 'Place 3')); // duplicate id: moves to front, not added twice
  const state = session.getState();
  const ids = state.recents.map((r) => r.id);
  assert.equal(state.recents.length, 8); // capped at MAX_RECENTS
  assert.equal(new Set(ids).size, ids.length); // deduped
  assert.deepEqual(ids, ['r3', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4']);
  assert.deepEqual(seen, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r3']); // every selection reached the seam
  assert.equal(state.open, false);
  assert.equal(state.query, '');
  assert.equal(state.selected.id, 'r3');
  assert.ok(storage.dump()); // persisted device-local
});

test('storage refusal degrades to session-only recents', async () => {
  const refused = { read: () => [], write: () => { throw new Error('storage refused'); } };
  const { session } = await makeSession({ storage: refused });
  session.select(res('s1', 'Berlin'));
  assert.equal(session.getState().recents.length, 1); // lives in the session
  const { session: fresh } = await makeSession({ storage: refused });
  assert.deepEqual(fresh.getState().recents, []); // but nothing persisted
});

test('without storage, recents are session-only too', async () => {
  const { session } = await makeSession();
  session.select(res('s1', 'Berlin'));
  assert.equal(session.getState().recents.length, 1);
  const { session: fresh } = await makeSession();
  assert.deepEqual(fresh.getState().recents, []);
});

test('clearInput and escape reset the session', async () => {
  const { session } = await makeSession({ suggest: async () => [res('s1', 'Berlin')] });
  session.input('ber');
  await waitDebounce();
  session.clearInput();
  assert.equal(session.phase(), 'recents');
  assert.equal(session.getState().query, '');
  assert.equal(session.getState().open, true); // panel stays open
  session.input('ber');
  await waitDebounce();
  session.escape();
  assert.equal(session.getState().open, false);
  assert.equal(session.getState().query, '');
});

test('clearRecents empties the list and persists the empty list', async () => {
  const storage = memoryStorage();
  const { session } = await makeSession({ storage });
  session.select(res('s1', 'Berlin'));
  assert.equal(session.getState().recents.length, 1);
  session.clearRecents();
  assert.deepEqual(session.getState().recents, []);
  assert.equal(storage.dump(), '[]');
});

test('arrow-key highlight wraps around the results', async () => {
  const { session } = await makeSession({
    suggest: async () => [res('a', 'Alpha'), res('b', 'Beta')],
  });
  session.input('al');
  await waitDebounce();
  assert.equal(session.getState().highlighted, -1);
  session.move(1);
  assert.equal(session.getState().highlighted, 0);
  session.move(1);
  assert.equal(session.getState().highlighted, 1);
  session.move(1); // wraps to the top
  assert.equal(session.getState().highlighted, 0);
  session.move(-1); // wraps to the bottom
  assert.equal(session.getState().highlighted, 1);
});

test('tapping a recent search re-runs it as a committed search', async () => {
  const { session, calls } = await makeSession({ search: async () => [res('c1', 'Berlin')] });
  session.select(res('c1', 'Berlin'));
  session.repeatRecent(session.getState().recents[0]);
  await waitDebounce();
  assert.equal(calls[0].mode, 'search');
  assert.equal(calls[0].q, 'Berlin');
  assert.equal(session.getState().query, 'Berlin');
  assert.equal(session.getState().open, true);
});

test('requireQuery and the map-area URL builders', async () => {
  const core = await import('../public/js/services/search-session.js');
  assert.throws(
    () => core.requireQuery('   '),
    (e) => e.code === 'invalid_query' && e.message === 'Enter a search term.',
  );
  assert.equal(core.requireQuery('  berlin '), 'berlin');
  assert.equal(
    core.searchInViewPath('ber lin', [1, 2, 3, 4]),
    '/api/search?q=ber%20lin&bbox=1,2,3,4',
  );
  assert.equal(
    core.searchNearPath('cafe', 48.86, 2.35, 5),
    '/api/search?q=cafe&near=48.86,2.35&radius=5',
  );
  assert.equal(core.searchNearPath('cafe', 48.86, 2.35, null), '/api/search?q=cafe&near=48.86,2.35');
  assert.throws(() => core.searchInViewPath('', [1, 2, 3, 4]), (e) => e.code === 'invalid_query');
});