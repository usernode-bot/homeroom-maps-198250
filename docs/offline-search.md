# Offline search (Phase 12B)

Offline search answers a search query from the map areas a person has already
downloaded to their device, with no network request. It is a client-side
feature: there is no server index, no new endpoint and no new database table.

## User guide

- Download a map area in **Offline Areas**. A downloaded area is what offline
  search reads; with nothing downloaded, offline search has nothing to search.
- When the device is offline, searching a name answers from the downloaded
  area. Each result is marked **Offline** and the panel names the area it
  searched, for example "Offline search covers only Staging demo area, a
  downloaded area on this device."
- Results are limited to the downloaded area's coverage. Offline search looks
  at one area per query: the area under the map center when the map knows it,
  otherwise the most recently completed one.
- Offline results come from the map tiles themselves, which carry fewer place
  names than the online geocoder. A short list here is honest, not a promise of
  online parity.
- With no downloaded areas while offline, the app says **No offline areas on
  this device** and points to Offline Areas. It never pretends to have searched
  the world.
- Online search is unchanged. When connectivity exists, results come from the
  same service as before and carry no Offline badge.

## Developer note

### `OfflineSearchIndex`

The master spec authorizes one interface on an ephemeral, in-memory index:

```
build(regionId, tiles)      fold each tile's `place` features into the index
query(text, bounds, limit)  a folded prefix-first scan with a bounds filter
delete(regionId)            drop a region's entries
```

`public/js/services/offline-search-index.js` implements this with
`buildIndexFromTiles`, `queryIndex` and the per-region `createIndexCache`.
`buildIndexFromTiles` is a thin loop over `createIndexBuilder`, the one
incremental implementation the worker and the chunked main-thread path also
call.

**No payload format is defined.** Persisting an index as an `index` artifact is
blocked until a format is authorized. The index lives in memory only, keyed per
region by the manifest's version token (`completedAt` else `createdAt`, plus
the zoom range). It is rebuilt from the stored tiles after a reload; a region
that is added, replaced or deleted invalidates its entry, and deleting a region
calls `deleteIndex` for it.

Folding (case and diacritics, via `String.prototype.normalize('NFD')`) happens
once at build time. A query is a linear scan over the folded names with
prefix-first ordering and an early limit.

### MVT decoder

`public/js/services/offline-search-tiles.js` is a minimal, dependency-free
reader for the Mapbox Vector Tile wire format. It reads only the `place` layer,
extracts each feature's `name`, optional `name:latin`/`name:en` and `class`, and
yields the first geometry vertex as the representative point. Malformed bytes
throw a typed `MvtDecodeError`; a feature with no name is skipped; a tile with
no `place` layer returns an empty list. No vector-tile parser is servable to
this app (MapLibre is vendored but does not export its parser, and
`@mapbox/vector-tile`/`pbf` are transitive), which is why this small reader
exists.

### Capability stages

`public/js/services/offline-search-capability.js` resolves one stage from the
server's `offline.search` block, device support and the stored region list:

| Stage | Condition |
| --- | --- |
| `ready` | flag on, IndexedDB available, at least one `complete` region with a `tiles` artifact |
| `no_regions` | flag on and IndexedDB available, but nothing eligible |
| `unsupported_browser` | no IndexedDB |
| `disabled` | operator flag off |

It fails closed: an absent or malformed `offline.search` block resolves as
`disabled`, never as `ready`. The resolver never throws and every input is
injectable. This gate does **not** depend on the Phase 12A download gate (B2),
because searching regions already stored on the device is a device-local read.

### Worker and chunked fallback

`public/js/services/offline-search-index.worker.js` is a module worker that
runs `buildIndexFromTiles` off the main thread.
`createWorkerTileIndexReader` in `offline-search.js` uses it when a module
`Worker` is available and falls back to `buildIndexChunked`
(`offline-search-index-chunked.js`), which yields between tiles. Both call the
same pure builder, so the worker is an optimization and never a test
dependency.
