// Offline search index — the pure, in-memory core (Phase 12B).
//
// The master spec authorizes exactly three operations on an offline search
// index and an ephemeral, in-memory implementation:
//
//   build(regionId, tiles)   fold each stored tile's `place` features into a
//                            flat, searchable list,
//   query(text, bounds, limit)  a folded prefix-first scan over that list,
//   delete(regionId)         drop a region's entries.
//
// It deliberately does NOT define a serialized index format. There is no byte
// layout, no schema and no `index` artifact: persisting an index is blocked
// until a payload format is authorized (see the change's docs). Everything
// here is rebuilt from the tiles the device already holds, and only holds for
// as long as the page lives.
//
// The one real cost worth avoiding is re-folding the same names on every
// keystroke, so folding (case + diacritic) happens ONCE at build time and the
// query scans the folded strings. Matching is a linear scan with prefix-first
// ordering and an early limit — honest for the tens of thousands of names a
// downloaded region carries, and never a promise of online search parity.
import { readPlaceFeatures } from './offline-search-tiles.js';

// How many names one region may contribute to the index. The memory budget in
// the spec (< 50 MB for 100k names) is why there is a cap at all: past it the
// builder keeps the names it has already placed and reports how many it
// dropped, rather than growing without bound.
export const DEFAULT_MAX_NAMES = 100000;

// Fold a string for matching: trim, case-fold and strip diacritics so
// "Bandung" matches "bandung" and "café" matches "cafe". NFD splits a base
// character from its combining marks and the \u0300-\u036f range removes them.
export function foldText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// A place entry's stable identity inside a region: the folded (primary) name
// together with the coordinate rounded past provider precision. Two zoom
// levels naming the same place produce the same key and collapse to one
// entry; genuinely distinct nearby places with different names do not.
function dedupeKey(entry) {
  return `${entry.foldedName}|${entry.lat.toFixed(4)}|${entry.lon.toFixed(4)}`;
}

// Build the searchable entry from one decoded place feature. Returns null for
// anything without a name or a finite position.
function entryFromFeature(feature, regionId) {
  const name = typeof feature.name === 'string' ? feature.name.trim() : '';
  const lat = Number(feature.lat);
  const lon = Number(feature.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const foldedName = foldText(name);
  if (!foldedName) return null;
  const latinName =
    typeof feature.latinName === 'string' && feature.latinName.trim() ? feature.latinName.trim() : null;
  return {
    id: feature.id || null,
    regionId,
    name,
    latinName,
    foldedName,
    foldedLatin: latinName ? foldText(latinName) : null,
    kind: typeof feature.klass === 'string' && feature.klass ? feature.klass : null,
    lat,
    lon,
  };
}

// The version token a manifest resolves to. A completed region's `completedAt`
// is the moment its tiles last changed; before that, `createdAt`. The zoom
// range is folded in because it decides which tiles were read. Any change to
// these invalidates the cached index for the region.
export function indexVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'unknown';
  const stamp = manifest.completedAt || manifest.createdAt || 'unversioned';
  const zoom = manifest.zoom || {};
  return `${stamp}|${zoom.min}-${zoom.max}`;
}

// The incremental builder both `buildIndexFromTiles` and the chunked/worker
// path use, so there is exactly one implementation of "fold a tile into the
// index". `addTile` returns how many entries it added; a tile that fails to
// decode is skipped and counted, never thrown.
export function createIndexBuilder({ regionId, bounds = null, zoom = null, maxNames = DEFAULT_MAX_NAMES } = {}) {
  const entries = [];
  const seen = new Set();
  let failedTiles = 0;
  let dropped = 0;

  return {
    addTile(tile) {
      if (!tile || tile.data == null) return 0;
      let features;
      try {
        features = readPlaceFeatures(tile.data, { z: tile.z, x: tile.x, y: tile.y });
      } catch {
        failedTiles += 1;
        return 0;
      }
      let added = 0;
      for (const feature of features) {
        if (entries.length >= maxNames) {
          dropped += 1;
          continue;
        }
        const entry = entryFromFeature(feature, regionId);
        if (!entry) continue;
        const key = dedupeKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
        added += 1;
      }
      return added;
    },
    finish() {
      return {
        regionId,
        bounds: bounds ? { ...bounds } : null,
        zoom: zoom ? { ...zoom } : null,
        entries,
        // Real counts of what could not be used, so the caller reports them
        // instead of implying completeness.
        failedTiles,
        dropped,
        builtAt: null,
      };
    },
  };
}

// Build an index for one region from the tiles already read out of the store.
//
// `tiles` is `[{ z, x, y, data }]`, where `data` is an ArrayBuffer/Uint8Array
// of MVT bytes. A tile that fails to decode is SKIPPED and counted in
// `failedTiles`: a partially readable region returns the names it could read
// and never claims the rest, and a whole-region failure surfaces as a
// non-zero count the caller turns into the honest error state.
export function buildIndexFromTiles(options = {}) {
  const builder = createIndexBuilder(options);
  for (const tile of Array.isArray(options.tiles) ? options.tiles : []) builder.addTile(tile);
  return builder.finish();
}

// Is a point inside a rectangular bounds? Inclusive edges; a null bounds
// means "no geographic restriction" (there is no region to filter by).
export function withinBounds(lat, lon, bounds) {
  if (!bounds) return true;
  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

// Score one entry against a folded query. Prefix matches rank above substring
// matches, and the primary name above the latin alias. Lower is better.
function matchRank(entry, query) {
  const inName = entry.foldedName.startsWith(query);
  const inLatin = entry.foldedLatin ? entry.foldedLatin.startsWith(query) : false;
  if (inName) return 0;
  if (inLatin) return 1;
  if (entry.foldedName.includes(query)) return 2;
  if (entry.foldedLatin && entry.foldedLatin.includes(query)) return 3;
  return -1; // no match
}

// Query one built index. Pure and synchronous: a linear scan over the folded
// names with prefix-first ordering, a bounds filter and an early limit. An
// empty query returns nothing rather than everything.
export function queryIndex(index, text, { bounds = null, limit = 10 } = {}) {
  const query = foldText(text);
  if (!query || !index || !Array.isArray(index.entries)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const matched = [];
  for (const entry of index.entries) {
    if (!withinBounds(entry.lat, entry.lon, bounds)) continue;
    const rank = matchRank(entry, query);
    if (rank < 0) continue;
    matched.push({ entry, rank });
  }
  matched.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return matched.slice(0, cap).map((m) => m.entry);
}

// Drop one region's index from the cache. Returns true when something was
// removed, false when the region was not cached.
export function deleteIndex(cache, regionId) {
  if (!cache || typeof cache !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(cache, regionId)) return false;
  delete cache[regionId];
  return true;
}

// The bounded per-region index cache. Keyed by region id; each slot records
// the manifest version token it was built from, so a region whose tiles or
// zoom range changed is rebuilt on next use and an unchanged one is reused.
export function createIndexCache() {
  const slots = new Map();
  return {
    size() {
      return slots.size;
    },
    get(regionId, version) {
      const slot = slots.get(regionId);
      if (!slot || slot.version !== version) return null;
      return slot.index;
    },
    set(regionId, version, index) {
      slots.set(regionId, { version, index });
      return index;
    },
    delete(regionId) {
      return slots.delete(regionId);
    },
    clear() {
      slots.clear();
    },
  };
}
