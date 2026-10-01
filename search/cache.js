// In-memory LRU cache for search results.
//
// Two TTLs, set by the caller: autocomplete suggestions live 5 minutes (they
// go stale fast and are cheap to refetch), committed searches 24 hours (a
// place lookup does not change meaningfully in a day). The cache exists
// mostly for politeness: repeated identical queries against the public
// default endpoints are exactly the pattern the public-geocoder usage
// policies call out as faulty.
//
// Per-process only; a restart simply empties it. The clock is injected so
// tests can advance time deterministically.
'use strict';

class SearchCache {
  constructor({ maxEntries = 500, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Touch for LRU: delete + re-set moves the key to the end.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.maxEntries) {
      // Evict the least recently used entry (the first key in insertion order).
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { SearchCache };