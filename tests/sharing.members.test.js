// Members client (Phase 12F) — the server-side platform directory wrapper,
// against a fake fetch. Covers: the 60s success-only roster cache, every
// failure mode mapping to honest unavailability (never a fabricated empty
// roster), and resolveRecipients' fail-closed direction plus each rejection
// (unknown handle, not on the roster, the caller themselves, canonical
// casing persisted, dedupe by id).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMembersClient, ROSTER_TTL_MS } = require('../sharing/members');
const { SharingError } = require('../sharing/model');

const BASE = 'https://platform.example/api/app-platform/v1';
const ROSTER = {
  members: [
    { id: 101, username: 'Alice' },
    { id: 102, username: 'bob' },
    { id: 103, username: 'carol' },
  ],
};

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// A fake fetch with a switchable mode and a call log.
function makeFetch({ mode = 'up', rosterBody = ROSTER } = {}) {
  const calls = [];
  const state = { mode, rosterBody };
  const impl = (url) => {
    calls.push(url);
    if (state.mode === 'down') return Promise.reject(new Error('network down'));
    if (state.mode === 'forbidden') return Promise.resolve(jsonRes(403, {}));
    if (state.mode === 'garbage') return Promise.resolve(jsonRes(200, '<html>'));
    if (url.includes('/users/lookup')) {
      const handle = decodeURIComponent(url.split('username=')[1] || '');
      const match = ROSTER.members.find(
        (m) => m.username.toLowerCase() === (handle || '').toLowerCase(),
      );
      if (match) return Promise.resolve(jsonRes(200, { found: true, user: match }));
      return Promise.resolve(jsonRes(200, { found: false, user: null }));
    }
    if (state.mode === 'error') return Promise.resolve(jsonRes(500, {}));
    return Promise.resolve(jsonRes(200, state.rosterBody));
  };
  return { impl, calls, state };
}

function makeClient(fetchOverrides, clock = { t: 0 }) {
  const fake = makeFetch(fetchOverrides);
  const client = createMembersClient({
    platformApiBase: BASE,
    appToken: 'app-token',
    fetchImpl: fake.impl,
    now: () => clock.t,
  });
  return { client, fake, clock };
}

test('roster: mapped to plain ids, cached for 60s, cache is success-only', async () => {
  const { client, fake, clock } = makeClient();
  const first = await client.roster('tok');
  assert.equal(first.available, true);
  assert.deepEqual(first.members, [
    { id: '101', username: 'Alice' },
    { id: '102', username: 'bob' },
    { id: '103', username: 'carol' },
  ]);

  // Within the TTL: no second network call.
  clock.t = ROSTER_TTL_MS - 1;
  await client.roster('tok');
  assert.equal(fake.calls.length, 1);

  // Past the TTL: one new call.
  clock.t = ROSTER_TTL_MS;
  const second = await client.roster('tok');
  assert.equal(fake.calls.length, 2);
  assert.equal(second.available, true);

  // A failure is NOT cached: the next call goes to the network again, so
  // recovery starts immediately.
  fake.state.mode = 'down';
  clock.t = ROSTER_TTL_MS * 2;
  const down = await client.roster('tok');
  assert.equal(down.available, false);
  assert.equal(down.reason, 'upstream_unreachable');
  fake.state.mode = 'up';
  clock.t = ROSTER_TTL_MS * 3;
  const recovered = await client.roster('tok');
  assert.equal(recovered.available, true);
});

test('roster failure modes are honest unavailability, never an empty roster', async () => {
  for (const [mode, reason] of [
    ['down', 'upstream_unreachable'],
    ['forbidden', 'not_a_member'],
    ['error', 'upstream_error'],
    ['garbage', 'upstream_error'],
  ]) {
    const { client } = makeClient({ mode });
    const out = await client.roster('tok');
    assert.equal(out.available, false, mode);
    assert.equal(out.reason, reason, mode);
  }
});

test('no platform base at all: unavailable, and nothing is fetched', async () => {
  const client = createMembersClient({ platformApiBase: '' });
  assert.equal(client.available(), false);
  const roster = await client.roster('tok');
  assert.equal(roster.available, false);
  assert.equal(roster.reason, 'not_configured');
  const lookup = await client.lookup('tok', 'bob');
  assert.equal(lookup.available, false);
});

test('resolveRecipients is fail-closed when the roster cannot be verified', async () => {
  const { client } = makeClient({ mode: 'down' });
  const out = await client.resolveRecipients('tok', ['bob'], { viewerId: '101' });
  assert.deepEqual(out, { available: false, reason: 'upstream_unreachable' });
  // No SharingError was thrown: the route turns this into 503, not 400.
});

test('resolveRecipients: canonical casing, dedupe, and each rejection', async () => {
  const { client } = makeClient();

  // "BOB" resolves to the directory's canonical "bob" and is deduped by id.
  // The order follows the handles as typed.
  const ok = await client.resolveRecipients('tok', ['BOB', 'bob', 'ALICE'], { viewerId: '103' });
  assert.equal(ok.available, true);
  assert.deepEqual(ok.recipients, [
    { userId: '102', username: 'bob' },
    { userId: '101', username: 'Alice' },
  ]);

  // Unknown handle: typed 400, naming the handle.
  await assert.rejects(
    () => client.resolveRecipients('tok', ['nobody'], { viewerId: '101' }),
    (err) =>
      err instanceof SharingError &&
      err.code === 'invalid_request' &&
      /Nobody called nobody/.test(err.message),
  );

  // Real user, not on this project's roster: also a typed 400.
  const { client: strictRoster } = makeClient({ rosterBody: { members: [{ id: 101, username: 'Alice' }] } });
  await assert.rejects(
    () => strictRoster.resolveRecipients('tok', ['bob'], { viewerId: '101' }),
    (err) =>
      err instanceof SharingError &&
      err.code === 'invalid_request' &&
      /not a member of this project/.test(err.message),
  );

  // The caller themselves: a typed 400 (belt and braces; the model already
  // excludes them by name and the store's unique index excludes them by id).
  await assert.rejects(
    () => client.resolveRecipients('tok', ['ALICE'], { viewerId: '101' }),
    (err) => err instanceof SharingError && err.code === 'invalid_request',
  );
});

test('resolveRecipients fails closed when the lookup endpoint is unreachable', async () => {
  const fake = makeFetch();
  fake.state.mode = 'down';
  // The roster was fetched once successfully, so caching alone would let the
  // resolution "succeed" — the lookup failure must still stop it.
  const clock = { t: 0 };
  const client = createMembersClient({
    platformApiBase: BASE,
    fetchImpl: fake.impl,
    now: () => clock.t,
  });
  await client.roster('tok'); // warms the cache
  fake.state.mode = 'down';
  const out = await client.resolveRecipients('tok', ['bob'], { viewerId: '101' });
  assert.deepEqual(out, { available: false, reason: 'upstream_unreachable' });
});
