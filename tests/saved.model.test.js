// Unit tests for the saved places model (saved/model.js) — the pure rules
// that decide who sees what and what is a valid list, place snapshot, note,
// message and comment. No database: these run everywhere, including the
// bare npm test without TEST_DATABASE_URL.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../saved/model');

function viewer(id, username = 'u' + id) {
  return { id, username };
}
function list(overrides = {}) {
  return {
    ownerId: 101,
    visibility: 'private',
    shareToken: null,
    ...overrides,
  };
}
function place(overrides = {}) {
  return {
    name: 'Corner Bakery',
    lat: 52.53861,
    lng: 13.41084,
    address: 'Kastanienallee, Berlin',
    kind: 'bakery',
    provider: 'photon',
    id: null,
    ...overrides,
  };
}

// ── visibility ────────────────────────────────────────────────────────────

test('private: only the owner sees and writes', () => {
  const l = list();
  assert.equal(model.canView(viewer(101), l), true);
  assert.equal(model.canView(viewer(102), l), false);
  assert.equal(model.canView(viewer(102), l, { key: 'anything' }), false);
  assert.equal(model.canWrite(viewer(101), l), true);
  assert.equal(model.canWrite(viewer(102), l), false);
});

test('public: everyone sees, only the owner writes', () => {
  const l = list({ visibility: 'public' });
  assert.equal(model.canView(viewer(102), l), true);
  assert.equal(model.canView(null, l), false);
  assert.equal(model.canWrite(viewer(102), l), false);
  assert.equal(model.canWrite(viewer(101), l), true);
});

test('link: only the exact share token opens it, and never to write', () => {
  const l = list({ visibility: 'link', shareToken: 'abc123' });
  assert.equal(model.canView(viewer(102), l), false);
  assert.equal(model.canView(viewer(102), l, { key: 'abc123' }), true);
  // A wrong or missing token is invisibility, not a forbidden error.
  assert.equal(model.canView(viewer(102), l, { key: 'zzz' }), false);
  assert.equal(model.canView(viewer(102), l, { key: '' }), false);
  // A token on a private or public list does nothing.
  assert.equal(model.canView(viewer(102), list({ key: 'abc123' }), { key: 'abc123' }), false);
  assert.equal(model.canWrite(viewer(102), l, { key: 'abc123' }), false);
});

test('string and numeric ids compare equal (the platform ids are strings)', () => {
  assert.equal(model.isOwner(viewer('101'), list({ ownerId: 101 })), true);
  assert.equal(model.isOwner(viewer(101), list({ ownerId: '101' })), true);
});

test('a list without a share token is never link-visible, even with a key', () => {
  const l = list({ visibility: 'link', shareToken: null });
  assert.equal(model.canView(viewer(102), l, { key: 'x' }), false);
});

// ── list validation ───────────────────────────────────────────────────────

test('create validation: name required, emoji from the palette, visibility whitelisted', () => {
  for (const [body, field] of [
    [{ name: '' }, 'name'],
    [{ name: '   ' }, 'name'],
    [{ name: 'x'.repeat(61) }, 'name'],
    [{ name: 'ok', emoji: '🎃' }, 'emoji'],
    [{ name: 'ok', visibility: 'everyone' }, 'visibility'],
  ]) {
    try {
      model.validateListInput(body);
      assert.fail(`expected ${JSON.stringify(body)} to be refused`);
    } catch (err) {
      assert.equal(err.code, 'invalid_list');
      assert.ok(err.fields[field], `expected a ${field} error`);
      assert.equal(err.status, 400);
    }
  }
});

test('create validation: defaults and cleaning', () => {
  const out = model.validateListInput({ name: '  Trip   to  Lisbon  ' });
  assert.equal(out.name, 'Trip to Lisbon');
  assert.equal(out.emoji, model.EMOJIS[0]);
  assert.equal(out.visibility, 'private');
  const out2 = model.validateListInput({ name: 'x', emoji: '☕', visibility: 'public' });
  assert.deepEqual(out2, { name: 'x', emoji: '☕', visibility: 'public' });
  assert.ok(model.EMOJIS.length >= 24);
});

test('patch validation: partial, merged by the store, but still strict', () => {
  assert.deepEqual(model.validateListInput({ visibility: 'link' }, { partial: true }), {
    visibility: 'link',
  });
  // An unknown field name is simply not picked up; a bad provided one throws.
  try {
    model.validateListInput({ visibility: 'link', emoji: '🔥' }, { partial: true });
    assert.fail('expected the bad emoji to be refused');
  } catch (err) {
    assert.equal(err.code, 'invalid_list');
    assert.ok(err.fields.emoji);
  }
});

// ── place snapshots and place keys ────────────────────────────────────────

test('a place snapshot requires a name and in-range coordinates', () => {
  assert.throws(() => model.validatePlace(place({ name: ' ' })), (err) => err.code === 'invalid_place');
  assert.throws(() => model.validatePlace(place({ lat: 91 })), (err) => err.code === 'invalid_place');
  assert.throws(() => model.validatePlace(place({ lng: 200 })), (err) => err.code === 'invalid_place');
  assert.throws(() => model.validatePlace(place({ lat: 'north' })), (err) => err.code === 'invalid_place');
  assert.throws(() => model.validatePlace(null), (err) => err.code === 'invalid_place');
  const ok = model.validatePlace(place({ lat: '52.53861', lng: 13.41084 }));
  assert.equal(ok.lat, 52.53861);
  assert.equal(ok.lng, 13.41084);
  // Strings are coerced for coordinates; address/kind/provider strings are kept.
  assert.equal(ok.address, 'Kastanienallee, Berlin');
});

test('optional snapshot fields are cleaned, clipped and null when empty', () => {
  const p = model.validatePlace(place({
    address: '  a  '.repeat(400),
    kind: ' bakery ',
    provider: '',
    id: '  ',
  }));
  assert.equal(p.address.length, 300);
  assert.equal(p.kind, 'bakery');
  assert.equal(p.provider, null);
  assert.equal(p.id, null);
});

test('place keys: provider ids stay stable, coordinate ids collapse to geometry', () => {
  assert.equal(model.placeKeyOf(place({ id: 'osm:123' })), 'photon:osm:123');
  assert.equal(model.placeKeyOf(place({ id: 'osm:123', provider: null })), 'search:osm:123');
  // The coordinate-fallback id (from placeFromSearchResult) is not an identity:
  // the same spot is the same key, rounded to 5 decimals, regardless of id.
  assert.equal(
    model.placeKeyOf(place({ id: '52.53861,13.41084', provider: null })),
    model.placeKeyOf(place({ id: null, provider: null })),
  );
  assert.equal(model.placeKeyOf(place({ id: null, provider: null, lat: 52.538607, lng: 13.410847 })),
    'coord:52.53861,13.41085');
  // Rounding to 5 decimals keeps near-identical saves identical.
  assert.equal(
    model.placeKeyOf(place({ id: null, lat: 52.538612, lng: 13.410841 })),
    'coord:52.53861,13.41084',
  );
});

// ── notes, messages, comments ─────────────────────────────────────────────

test('notes and messages: cleaned, empty becomes null, length limited', () => {
  assert.equal(model.validateNote('  hi  '), 'hi');
  assert.equal(model.validateNote(undefined), null);
  assert.equal(model.validateNote('   '), null);
  assert.throws(() => model.validateNote('x'.repeat(501)), (err) => err.code === 'invalid_place');
  assert.equal(model.validateMessage('line1\n\n\nline2'), 'line1\n\nline2');
  assert.throws(() => model.validateMessage('x'.repeat(201)), (err) => err.code === 'invalid_place');
});

test('comment bodies: empty refused, 1000 characters allowed', () => {
  // Trimmed; inner spacing is the author's, blank lines collapse.
  assert.equal(model.validateCommentBody(' hello  world '), 'hello  world');
  assert.equal(model.validateCommentBody('x'.repeat(1000)), 'x'.repeat(1000));
  assert.throws(() => model.validateCommentBody('   '), (err) => err.code === 'invalid_comment');
  assert.throws(() => model.validateCommentBody('x'.repeat(1001)), (err) => err.code === 'comment_too_long');
});

// ── paging, tokens, defaults ──────────────────────────────────────────────

test('paging: clamped and defaulted', () => {
  assert.deepEqual(model.parsePageQuery(), { limit: 20, offset: 0 });
  assert.deepEqual(model.parsePageQuery({ limit: '10', offset: '30' }), { limit: 10, offset: 30 });
  assert.deepEqual(model.parsePageQuery({ limit: '500', offset: '-5' }), { limit: 50, offset: 0 });
  assert.deepEqual(model.parsePageQuery({ limit: 'abc' }), { limit: 20, offset: 0 });
});

test('share tokens are 32 hex characters and unique', () => {
  const a = model.generateShareToken();
  const b = model.generateShareToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('the four default lists exist with palette emojis', () => {
  assert.equal(model.DEFAULT_LISTS.length, 4);
  for (const d of model.DEFAULT_LISTS) {
    assert.ok(model.EMOJIS.includes(d.emoji));
    assert.ok(d.name.length > 0);
  }
});

test('the client palette matches the server palette exactly', async () => {
  const client = await import('../public/js/components/saved/parts.js');
  assert.deepEqual([...client.EMOJIS], [...model.EMOJIS]);
});
