// Tests for the client-side community feed core (community-feed.js): the
// pure state machine behind the Community screen. Browser ESM with zero
// imports, loaded via dynamic import like search-session.js; the page
// fetcher is injected.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let core;
test.before(async () => {
  core = await import('../public/js/services/community-feed.js');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const item = (id, score = 0) => ({ id: String(id), votes: { up: score, down: 0, score }, viewer: { vote: 0 } });

test('loading, then ready with the server items', async () => {
  const d = deferred();
  const seen = [];
  const feed = core.createFeed({ fetchPage: () => d.promise, onChange: (s) => seen.push(s.status) });
  const p = feed.load('recent');
  assert.equal(feed.getState().status, 'loading');
  assert.deepEqual(feed.getState().items, []);
  d.resolve({ items: [item(1), item(2)], hasMore: false, nextOffset: null });
  await p;
  assert.equal(feed.getState().status, 'ready');
  assert.deepEqual(feed.getState().items.map((x) => x.id), ['1', '2']);
  assert.deepEqual(seen, ['loading', 'ready']);
});

test('an empty answer is the empty state, never invented rows', async () => {
  const feed = core.createFeed({ fetchPage: async () => ({ items: [], hasMore: false }) });
  await feed.load('implemented');
  assert.equal(feed.getState().status, 'empty');
  assert.equal(feed.getState().view, 'implemented');
  assert.deepEqual(feed.getState().items, []);
});

test('a failure is the error state, and retry reloads the same view', async () => {
  let calls = 0;
  const feed = core.createFeed({
    fetchPage: async (view) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('We could not reach the server.'), { code: 'network_error' });
      return { items: [item(view === 'popular' ? 9 : 1)] };
    },
  });
  await feed.load('popular');
  assert.equal(feed.getState().status, 'error');
  assert.equal(feed.getState().error.code, 'network_error');
  await feed.retry();
  assert.equal(feed.getState().status, 'ready');
  assert.equal(feed.getState().view, 'popular');
  assert.equal(feed.getState().items[0].id, '9');
});

test('a slow answer for an old view never overwrites the newer view', async () => {
  const slow = deferred();
  const feed = core.createFeed({
    fetchPage: (view) => (view === 'recent' ? slow.promise : Promise.resolve({ items: [item('p')] })),
  });
  const first = feed.load('recent');
  await feed.load('popular');
  slow.resolve({ items: [item('r')] });
  await first;
  assert.equal(feed.getState().view, 'popular');
  assert.deepEqual(feed.getState().items.map((x) => x.id), ['p']);
});

test('nearby without a location asks for one and makes no request', async () => {
  let calls = 0;
  const feed = core.createFeed({ fetchPage: async () => { calls += 1; return { items: [] }; } });
  feed.needLocation('nearby');
  assert.equal(feed.getState().status, 'needs_location');
  assert.equal(calls, 0);
  await feed.load('nearby', { near: { lat: 1, lng: 2 } });
  assert.equal(calls, 1);
});

test('paging appends, dedupes, keeps params, and surfaces a paging error separately', async () => {
  const calls = [];
  let fail = false;
  const feed = core.createFeed({
    fetchPage: async (view, opts) => {
      calls.push(opts);
      if (fail) throw new Error('boom');
      return opts.offset === 0
        ? { items: [item(1), item(2)], hasMore: true, nextOffset: 2 }
        : { items: [item(2), item(3)], hasMore: false, nextOffset: null };
    },
  });
  await feed.load('nearby', { near: { lat: 1, lng: 2 } });
  fail = true;
  await feed.loadMore();
  assert.equal(feed.getState().status, 'ready');
  assert.equal(feed.getState().moreError.message, 'boom');
  assert.equal(feed.getState().items.length, 2);
  fail = false;
  await feed.loadMore();
  assert.deepEqual(feed.getState().items.map((x) => x.id), ['1', '2', '3']);
  assert.equal(feed.getState().hasMore, false);
  assert.deepEqual(calls[2], { near: { lat: 1, lng: 2 }, offset: 2 });
});

test('replace swaps in the server copy of one proposal only', async () => {
  const feed = core.createFeed({ fetchPage: async () => ({ items: [item(1), item(2)] }) });
  await feed.load('recent');
  feed.replace({ ...item(2, 5), viewer: { vote: 1 } });
  assert.equal(feed.getState().items[1].votes.score, 5);
  assert.equal(feed.getState().items[0].votes.score, 0);
  feed.replace(item(99, 7));
  assert.equal(feed.getState().items.length, 2);
});

test('vote taps: same direction withdraws, otherwise cast or change', () => {
  assert.deepEqual(core.voteRequest(0, 1), { method: 'PUT', value: 1 });
  assert.deepEqual(core.voteRequest(1, 1), { method: 'DELETE' });
  assert.deepEqual(core.voteRequest(1, -1), { method: 'PUT', value: -1 });
  assert.deepEqual(core.voteRequest(-1, -1), { method: 'DELETE' });
  assert.throws(() => core.voteRequest(0, 0));
});

test('feedPath carries the nearby centre only for nearby', () => {
  assert.equal(core.feedPath('recent', { offset: 20 }), '/api/community/proposals?view=recent&offset=20&limit=20');
  assert.equal(
    core.feedPath('nearby', { near: { lat: 52.123456, lng: 13.4 } }),
    '/api/community/proposals?view=nearby&offset=0&limit=20&near=52.12346%2C13.40000',
  );
  assert.ok(!core.feedPath('popular', { near: { lat: 1, lng: 2 } }).includes('near'));
});
