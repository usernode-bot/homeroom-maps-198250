// Tests for the Phase 9 kind-label localization in the search pipeline: the
// additive post-process in search/index.js driven by localizeDetailLine in
// search/normalize.js. English (and every language without a table) must pass
// through byte-identical with Phase 2; Indonesian rewrites only an exact
// leading label.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../search');
const { register } = require('../search/provider');
const { localizeDetailLine } = require('../search/normalize');

// A normalized-shaped result with the precomposed English detail line that
// normalizeResult/detailLine produce server-side.
function res(id, kind, detail) {
  return {
    id,
    kind,
    name: detail || id,
    localName: null,
    detail: detail || id,
    address: {},
    addressLine: null,
    lat: 1,
    lon: 2,
    provider: 'stub',
  };
}

function stubProvider(name, results) {
  const adapter = {
    name,
    public: false, // never touch the shared rate limiter in tests
    supportsSuggest: true,
    isConfigured: () => true,
    suggest: async () => results,
    search: async () => results,
  };
  register(adapter);
  return adapter;
}

// ---- the pure rewriter ----

test('Indonesian rewrites a leading English kind label', () => {
  assert.equal(localizeDetailLine('City, Berlin, Germany', 'city', 'id'), 'Kota, Berlin, Germany');
  assert.equal(localizeDetailLine('Country, Indonesia', 'country', 'id'), 'Negara, Indonesia');
  assert.equal(localizeDetailLine('Place, Café Batavia', 'poi', 'id'), 'Tempat, Café Batavia');
});

test('a bare label (no parts) is rewritten whole', () => {
  assert.equal(localizeDetailLine('City', 'city', 'id'), 'Kota');
});

test('English and null languages pass through unchanged', () => {
  assert.equal(localizeDetailLine('City, Berlin, Germany', 'city', 'en'), 'City, Berlin, Germany');
  assert.equal(localizeDetailLine('City, Berlin, Germany', 'city', null), 'City, Berlin, Germany');
  assert.equal(localizeDetailLine('City, Berlin, Germany', 'city', 'pt-BR'), 'City, Berlin, Germany');
  assert.equal(localizeDetailLine('City, Berlin, Germany', 'city', 'garbage'), 'City, Berlin, Germany');
});

test('a detail line that does not start with the label is untouched', () => {
  // detailLine falls back to the bare name when there is no kind label
  assert.equal(localizeDetailLine('Unter den Linden', 'street', 'id'), 'Unter den Linden');
  // and a mid-line mention of the label word is not rewritten
  assert.equal(localizeDetailLine('Sea City, WA, United States', 'city', 'id'), 'Sea City, WA, United States');
});

test('unusable input passes through', () => {
  assert.equal(localizeDetailLine(null, 'city', 'id'), null);
  assert.equal(localizeDetailLine('x', null, 'id'), 'x');
  assert.equal(localizeDetailLine('', 'city', 'id'), '');
});

// ---- through the pipeline ----

test('run() applies Indonesian labels when the request resolves to id', async () => {
  const stub = stubProvider('labels-id', [
    res('l1', 'city', 'City, Berlin, Germany'),
    res('l2', 'poi', 'Place, Café Batavia'),
  ]);
  const out = await run('search', { q: 'berlin labels' }, { lang: 'id' }, { providerName: 'labels-id' });
  assert.deepEqual(out.results.map((r) => r.detail), ['Kota, Berlin, Germany', 'Tempat, Café Batavia']);
  // the same query with no language keeps the Phase 2 English line exactly
  const english = await run('search', { q: 'berlin labels english' }, {}, { providerName: 'labels-id' });
  assert.equal(english.results[0].detail, 'City, Berlin, Germany');
});

test('localized labels survive a cache hit, and the cache stays language-neutral', async () => {
  const stub = stubProvider('labels-cache', [res('c1', 'city', 'City, Berlin, Germany')]);
  const id = await run('search', { q: 'cache labels' }, { lang: 'id' }, { providerName: 'labels-cache' });
  assert.equal(id.results[0].detail, 'Kota, Berlin, Germany');
  assert.equal(id.cached, false);
  const idAgain = await run('search', { q: 'cache labels' }, { lang: 'id' }, { providerName: 'labels-cache' });
  assert.equal(idAgain.cached, true);
  assert.equal(idAgain.results[0].detail, 'Kota, Berlin, Germany');
  // a different language is a different cache entry with its own labels
  const english = await run('search', { q: 'cache labels' }, { lang: 'en' }, { providerName: 'labels-cache' });
  assert.equal(english.results[0].detail, 'City, Berlin, Germany');
});
