// Tests for the saved places service contract (public/js/services/saved.js):
// every call's method and URL, the body it sends, the shapes it normalises,
// and the two pure helpers (placeToSnapshot, hasCoords) that map the Place
// model a search produces into the snapshot the server stores.
//
// The fetch layer is stubbed at its seam — global fetch — so the real
// service code runs end to end (api.js included) while no network exists.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let saved = null;
async function loadModule() {
  if (saved) return;
  // auth.js reads window.location.search at import time to pick up the
  // platform's injected token; in Node there is no window, and no token is
  // exactly what the service should see here.
  globalThis.window = { location: { search: '' } };
  saved = await import('../public/js/services/saved.js');
}
function savedTest(name, fn) {
  return test(name, async (t) => {
    await loadModule();
    return fn(t);
  });
}

// Installs a fetch stub answering `payload` (or, when given an array, the
// next entry per call) for every request and recording them; returns
// { calls, restore }.
function stubFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const queue = Array.isArray(payload) ? [...payload] : null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      method: init.method || 'GET',
      url: String(url),
      body: init.body === undefined ? null : JSON.parse(init.body),
    });
    const next = queue ? queue.shift() : payload;
    return new Response(JSON.stringify(next), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const ok = { ok: true };

savedTest('fetchMyLists GETs the mine view and answers its items array', async () => {
  const stub = stubFetch({ items: [{ id: 'l1' }], hasMore: false });
  try {
    const items = await saved.fetchMyLists();
    assert.deepEqual(items, [{ id: 'l1' }]);
    assert.deepEqual(stub.calls, [{ method: 'GET', url: '/api/saved/lists?view=mine', body: null }]);
  } finally {
    stub.restore();
  }
});

savedTest('fetchMyLists answers [] when the body is not shaped as expected', async () => {
  const stub = stubFetch(null);
  try {
    assert.deepEqual(await saved.fetchMyLists(), []);
  } finally {
    stub.restore();
  }
});

savedTest('fetchPublicLists encodes paging and carries hasMore/nextOffset through', async () => {
  const stub = stubFetch({ items: [{ id: 'l2' }], hasMore: true, nextOffset: 40 });
  try {
    const page = await saved.fetchPublicLists({ offset: 20, limit: 20 });
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 40);
    assert.deepEqual(stub.calls[0].url, '/api/saved/lists?view=public&offset=20&limit=20');
    // No paging requested -> no paging params at all.
    await saved.fetchPublicLists();
    assert.equal(stub.calls[1].url, '/api/saved/lists?view=public');
  } finally {
    stub.restore();
  }
});

savedTest('fetchList normalises the detail shape and rides the share key on the URL', async () => {
  const stub = stubFetch([
    {
      list: { id: 'l1', visibility: 'link' },
      items: [{ id: 'i1' }],
      suggestions: [],
      viewer: { isOwner: false, canWrite: false },
    },
    null,
  ]);
  try {
    const detail = await saved.fetchList('l1', { key: 'abc 123/def' });
    assert.equal(detail.list.id, 'l1');
    assert.deepEqual(detail.items, [{ id: 'i1' }]);
    assert.deepEqual(detail.viewer, { isOwner: false, canWrite: false });
    assert.equal(stub.calls[0].url, '/api/saved/lists/l1?key=abc%20123%2Fdef');
    // A missing shape degrades to empty/false, never undefined.
    const empty = await saved.fetchList('l1');
    assert.equal(stub.calls[1].url, '/api/saved/lists/l1');
    assert.deepEqual(empty, { list: null, items: [], suggestions: [], viewer: { isOwner: false, canWrite: false } });
  } finally {
    stub.restore();
  }
});

savedTest('list writes use the right verb and path', async () => {
  const stub = stubFetch(ok);
  try {
    await saved.createList({ name: 'Trip', emoji: '🥐', visibility: 'public' });
    assert.deepEqual(stub.calls[0], {
      method: 'POST', url: '/api/saved/lists',
      body: { name: 'Trip', emoji: '🥐', visibility: 'public' },
    });
    await saved.updateList('l1', { visibility: 'link' });
    assert.deepEqual(stub.calls[1], { method: 'PATCH', url: '/api/saved/lists/l1', body: { visibility: 'link' } });
    await saved.deleteList('l1');
    assert.deepEqual(stub.calls[2], { method: 'DELETE', url: '/api/saved/lists/l1', body: null });
  } finally {
    stub.restore();
  }
});

savedTest('items, suggestions and decisions use the right verb, path and body', async () => {
  const stub = stubFetch(ok);
  try {
    const place = { name: 'Corner Bakery', lat: 52.5, lng: 13.4 };
    await saved.addPlace('l1', place, { note: 'Go early.' });
    assert.deepEqual(stub.calls[0], {
      method: 'POST', url: '/api/saved/lists/l1/items',
      body: { place, note: 'Go early.' },
    });
    await saved.updateNote('l1', 'i1', 'Go earlier.');
    assert.deepEqual(stub.calls[1], {
      method: 'PATCH', url: '/api/saved/lists/l1/items/i1',
      body: { note: 'Go earlier.' },
    });
    await saved.removePlace('l1', 'i1');
    assert.deepEqual(stub.calls[2], { method: 'DELETE', url: '/api/saved/lists/l1/items/i1', body: null });
    await saved.suggestPlace('l2', place, 'Best bread around.');
    assert.deepEqual(stub.calls[3], {
      method: 'POST', url: '/api/saved/lists/l2/suggestions',
      body: { place, message: 'Best bread around.' },
    });
    await saved.acceptSuggestion('s1');
    assert.deepEqual(stub.calls[4], { method: 'POST', url: '/api/saved/suggestions/s1/accept', body: null });
    await saved.rejectSuggestion('s1');
    assert.deepEqual(stub.calls[5], { method: 'POST', url: '/api/saved/suggestions/s1/reject', body: null });
  } finally {
    stub.restore();
  }
});

savedTest('comments read and write through, with the key where a viewer needs one', async () => {
  const stub = stubFetch({ items: [{ id: 'c1' }] });
  try {
    const items = await saved.fetchComments('i1');
    assert.deepEqual(items, [{ id: 'c1' }]);
    assert.deepEqual(stub.calls[0], { method: 'GET', url: '/api/saved/items/i1/comments', body: null });
    await saved.addComment('i1', 'Nice spot.', { key: 'k1' });
    assert.deepEqual(stub.calls[1], {
      method: 'POST', url: '/api/saved/items/i1/comments?key=k1',
      body: { body: 'Nice spot.' },
    });
    await saved.deleteComment('c1');
    assert.deepEqual(stub.calls[2], { method: 'DELETE', url: '/api/saved/comments/c1', body: null });
  } finally {
    stub.restore();
  }
});

savedTest('server errors surface as typed ApiErrors with their code and fields', async () => {
  const stub = stubFetch(
    { error: { code: 'already_in_list', message: 'Already there.', fields: { place: 'dup' } } },
    { status: 409 },
  );
  try {
    await assert.rejects(
      () => saved.addPlace('l1', { name: 'X', lat: 1, lng: 2 }),
      (err) => {
        assert.equal(err.name, 'ApiError');
        assert.equal(err.status, 409);
        assert.equal(err.code, 'already_in_list');
        assert.deepEqual(err.fields, { place: 'dup' });
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

savedTest('placeToSnapshot maps the Place model into the stored snapshot', async () => {
  assert.deepEqual(
    saved.placeToSnapshot({
      id: 'osm:way/123',
      name: 'Corner Bakery',
      address: 'Kastanienallee, Berlin',
      category: 'food',
      subcategory: 'bakery',
      dataSource: 'photon',
      coordinates: { lat: 52.53861, lon: 13.41084 },
    }),
    {
      name: 'Corner Bakery',
      lat: 52.53861,
      lng: 13.41084,
      address: 'Kastanienallee, Berlin',
      kind: 'bakery',
      provider: 'photon',
      id: 'osm:way/123',
    },
  );
  // No subcategory: the category stands in. A placeholder provider is not
  // one: "unknown" becomes null so the coordinate key applies.
  const partial = saved.placeToSnapshot({
    id: 42, // non-string ids are not identities
    name: 'A spot',
    category: 'leisure',
    dataSource: 'unknown',
    coordinates: { lat: 1, lon: 2 },
  });
  assert.deepEqual(partial, {
    name: 'A spot', lat: 1, lng: 2, address: null, kind: 'leisure', provider: null, id: null,
  });
  assert.equal(saved.placeToSnapshot(null), null);
});

savedTest('hasCoords gates saving on finite coordinates', () => {
  assert.equal(saved.hasCoords({ coordinates: { lat: 1, lon: 2 } }), true);
  assert.equal(saved.hasCoords({ coordinates: { lat: NaN, lon: 2 } }), false);
  assert.equal(saved.hasCoords({}), false);
  assert.equal(saved.hasCoords(null), false);
});