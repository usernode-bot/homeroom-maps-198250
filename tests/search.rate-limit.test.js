// Unit tests for the search rate limiter (search/rate-limit.js) and the
// result cache (search/cache.js). Both take an injected clock so time
// advances deterministically.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenBucket } = require('../search/rate-limit');
const { SearchCache } = require('../search/cache');

test('token bucket allows a burst up to capacity, then rejects', () => {
  let t = 0;
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(bucket.tryTake(), true, `take ${i}`);
  assert.equal(bucket.tryTake(), false); // 6th in the burst is over the limit
});

test('token bucket refills over time, fractionally', () => {
  let t = 0;
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => t });
  bucket.tryTake();
  bucket.tryTake();
  assert.equal(bucket.tryTake(), false);
  t = 1000; // exactly one token has refilled
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  t = 1500; // half a token: still short
  assert.equal(bucket.tryTake(), false);
  t = 2000;
  assert.equal(bucket.tryTake(), true);
});

test('token bucket does not exceed capacity while idle', () => {
  let t = 0;
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: () => t });
  bucket.tryTake();
  t = 60_000; // idle a minute: still only 3 tokens available
  for (let i = 0; i < 3; i++) assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
});

test('takeOrThrow throws the typed rate_limited error when empty', () => {
  let t = 0;
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, now: () => t });
  bucket.tryTake();
  assert.throws(() => bucket.takeOrThrow(), (e) => e.code === 'rate_limited');
});

test('search cache returns values until the TTL expires', () => {
  let t = 0;
  const cache = new SearchCache({ now: () => t });
  cache.set('a', [1, 2, 3], 5000);
  assert.deepEqual(cache.get('a'), [1, 2, 3]);
  t = 5000; // exactly at expiry: gone
  assert.equal(cache.get('a'), undefined);
});

test('search cache evicts the least recently used entry when full', () => {
  let t = 0;
  const cache = new SearchCache({ maxEntries: 2, now: () => t });
  cache.set('a', 'A', 60_000);
  cache.set('b', 'B', 60_000);
  cache.get('a'); // touch a, so b becomes the LRU entry
  cache.set('c', 'C', 60_000);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 'C');
});

test('search cache clear() empties everything', () => {
  const cache = new SearchCache({ now: () => 0 });
  cache.set('a', 'A', 60_000);
  cache.clear();
  assert.equal(cache.get('a'), undefined);
});