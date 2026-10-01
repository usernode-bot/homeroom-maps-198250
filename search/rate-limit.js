// In-memory token bucket protecting the free PUBLIC geocoder endpoints the
// app may default to (Photon's demo server, the OSM Nominatim instance).
//
// These services police aggregate request rate per source IP, summed over all
// users of the app — Nominatim's policy caps it at an absolute 1 request per
// second, and Photon throttles "extensive use". A single-process bucket with
// a 1/s refill and a small burst bounds this app's outbound rate regardless
// of how many users are typing. Keyed commercial adapters skip the bucket.
//
// The clock is injected so tests can advance time deterministically.
'use strict';

const { searchError } = require('./provider');

class TokenBucket {
  constructor({ capacity, refillPerSecond, now = () => Date.now() } = {}) {
    if (!(capacity > 0) || !(refillPerSecond > 0)) {
      throw new Error('TokenBucket needs a positive capacity and refillPerSecond.');
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.lastRefillAt = now();
  }

  // Refill lazily: the bucket earns tokens proportional to elapsed time.
  refill() {
    const t = this.now();
    const elapsed = (t - this.lastRefillAt) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
      this.lastRefillAt = t;
    }
  }

  // Take one token if available. Does NOT wait — a queued request would hold
  // a browser fetch open for seconds; the client surfaces the typed error
  // state instead and the user taps Try again.
  tryTake() {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  // Throw the typed rate_limited error when the bucket is empty. This is the
  // helper adapters' pipeline calls, so one place owns the message.
  takeOrThrow() {
    if (!this.tryTake()) {
      throw searchError(
        'rate_limited',
        'Search is busy right now. Try again in a moment.',
      );
    }
  }
}

module.exports = { TokenBucket };