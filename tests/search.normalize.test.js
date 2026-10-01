// Unit tests for search/normalize.js — pure validation and normalization.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateQuery,
  parseBbox,
  parseNear,
  parseLimit,
  firstAcceptLanguage,
  primarySubtag,
  detailLine,
  normalizeResult,
} = require('../search/normalize');

test('validateQuery trims surrounding whitespace', () => {
  assert.equal(validateQuery('  Berlin  '), 'Berlin');
});

test('validateQuery rejects an empty or whitespace-only query as invalid_query', () => {
  assert.throws(() => validateQuery('   '), (e) => e.code === 'invalid_query');
  assert.throws(() => validateQuery(undefined), (e) => e.code === 'invalid_query');
});

test('validateQuery rejects queries over 200 characters', () => {
  assert.throws(() => validateQuery('a'.repeat(201)), (e) => e.code === 'invalid_query');
  assert.equal(validateQuery('a'.repeat(200)), 'a'.repeat(200));
});

test('parseBbox accepts minLon,minLat,maxLon,maxLat and returns null when absent', () => {
  assert.deepEqual(parseBbox('13.30,52.45,13.45,52.56'), [13.30, 52.45, 13.45, 52.56]);
  assert.equal(parseBbox(undefined), null);
  assert.equal(parseBbox(''), null);
});

test('parseBbox rejects malformed and inverted areas', () => {
  assert.throws(() => parseBbox('1,2,3'), (e) => e.code === 'invalid_query');
  assert.throws(() => parseBbox('a,b,c,d'), (e) => e.code === 'invalid_query');
  // minLon > maxLon (inverted) must fail, not silently return nothing.
  assert.throws(() => parseBbox('13.45,52.45,13.30,52.56'), (e) => e.code === 'invalid_query');
  assert.throws(() => parseBbox('13.30,52.56,13.45,52.45'), (e) => e.code === 'invalid_query');
});

test('parseNear parses lat,lon with a clamped radius', () => {
  assert.deepEqual(parseNear('52.5,13.4', '15'), { lat: 52.5, lon: 13.4, radiusKm: 15 });
  assert.deepEqual(parseNear('52.5,13.4'), { lat: 52.5, lon: 13.4, radiusKm: 10 });
  assert.deepEqual(parseNear('52.5,13.4', '9999'), { lat: 52.5, lon: 13.4, radiusKm: 100 });
  assert.deepEqual(parseNear('52.5,13.4', 'abc'), { lat: 52.5, lon: 13.4, radiusKm: 10 });
  assert.equal(parseNear(undefined), null);
  assert.throws(() => parseNear('52.5'), (e) => e.code === 'invalid_query');
});

test('parseLimit clamps to 1..20 and falls back on garbage', () => {
  assert.equal(parseLimit('30', 10), 20);
  assert.equal(parseLimit('5', 10), 5);
  assert.equal(parseLimit('abc', 8), 8);
  assert.equal(parseLimit('-3', 8), 8);
  assert.equal(parseLimit('0', 8), 8);
});

test('firstAcceptLanguage takes the first tag and ignores q-values', () => {
  assert.equal(firstAcceptLanguage('de-DE,de;q=0.9,en;q=0.8'), 'de-DE');
  assert.equal(firstAcceptLanguage(' pt-BR '), 'pt-BR');
  assert.equal(firstAcceptLanguage(undefined), null);
  assert.equal(firstAcceptLanguage(''), null);
  assert.equal(firstAcceptLanguage('*'), null);
});

test('primarySubtag reduces BCP-47 to the language subtag', () => {
  assert.equal(primarySubtag('pt-BR'), 'pt');
  assert.equal(primarySubtag('DE'), 'de');
  assert.equal(primarySubtag(null), null);
  assert.equal(primarySubtag('123'), null);
});

test('detailLine drops empty parts and collapses consecutive duplicates', () => {
  assert.equal(detailLine('City', ['Berlin', 'Berlin', 'Deutschland']), 'City, Berlin, Deutschland');
  assert.equal(detailLine('Address', ['', null, 'Hauptstraße 12', '10115 Berlin']), 'Address, Hauptstraße 12, 10115 Berlin');
  assert.equal(detailLine('City', []), 'City');
});

test('detailLine truncates very long lines', () => {
  const line = detailLine('Place', ['x'.repeat(300)]);
  assert.ok(line.length <= 140);
  assert.ok(line.endsWith('…'));
});

test('normalizeResult fills defaults and keeps the kind whitelist', () => {
  const out = normalizeResult({
    id: 'photon:osm.node.1',
    kind: 'city',
    name: 'Berlin',
    detail: 'City, Deutschland',
    lat: 52.5,
    lon: 13.4,
    provider: 'photon',
  });
  assert.deepEqual(out.address, {
    houseNumber: null, street: null, city: null, state: null,
    postcode: null, country: null, countryCode: null,
  });
  assert.equal(out.localName, null);
  assert.equal(out.addressLine, null);
});

test('normalizeResult keeps localName only when it differs from name', () => {
  const same = normalizeResult({ name: 'Berlin', localName: 'Berlin', lat: 1, lon: 2 });
  assert.equal(same.localName, null);
  const diff = normalizeResult({ name: 'Munich', localName: 'München', lat: 1, lon: 2 });
  assert.equal(diff.localName, 'München');
});

test('normalizeResult maps unknown kinds to other and nulls unusable input', () => {
  assert.equal(normalizeResult({ name: 'X', kind: 'banana', lat: 1, lon: 2 }).kind, 'other');
  assert.equal(normalizeResult({ name: '', lat: 1, lon: 2 }), null);
  assert.equal(normalizeResult({ name: 'X', lat: 'north', lon: 2 }), null);
  assert.equal(normalizeResult(null), null);
});