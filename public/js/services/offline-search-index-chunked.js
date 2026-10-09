// Offline search index — the chunked, yielding main-thread build (Phase 12B).
//
// The worker (offline-search-index.worker.js) is the preferred path. This is
// the fallback for browsers without module-worker support and the fallback if
// a worker build fails: it runs the SAME pure builder (createIndexBuilder),
// but hands control back to the event loop every `budget` tiles so a long
// region never freezes the UI.
//
// Kept separate from offline-search-index.js so that module stays a pure,
// synchronous core with no timer dependency; this one is the only piece that
// yields.
import { createIndexBuilder } from './offline-search-index.js';

export async function buildIndexChunked(options = {}, { budget = 50, yieldTo = null } = {}) {
  const builder = createIndexBuilder({
    regionId: options.regionId,
    bounds: options.bounds || null,
    zoom: options.zoom || null,
    ...(Number.isInteger(options.maxNames) ? { maxNames: options.maxNames } : {}),
  });
  const tiles = Array.isArray(options.tiles) ? options.tiles : [];
  const yieldFn =
    typeof yieldTo === 'function'
      ? yieldTo
      : () => new Promise((resolve) => setTimeout(resolve, 0));
  let since = 0;
  for (const tile of tiles) {
    builder.addTile(tile);
    since += 1;
    if (since >= budget) {
      since = 0;
      await yieldFn();
    }
  }
  return builder.finish();
}
