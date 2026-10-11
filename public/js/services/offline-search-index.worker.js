// Offline search index worker (Phase 12B).
//
// A module Web Worker that builds one region's index off the main thread. The
// builder it calls is the SAME pure implementation the main thread and the
// tests use (offline-search-index.js) — the worker is an optimization, never a
// second implementation and never a test dependency.
//
// Protocol (message in, message out):
//   { type: 'build', requestId, regionId, bounds, zoom, tiles }
//     -> { type: 'index', requestId, index } | { type: 'error', requestId, message }
//
// `tiles` is a structured-cloneable array of `{ z, x, y, data }`; the data
// buffers arrive as ArrayBuffers/Uint8Arrays, exactly what the reader takes.
import { buildIndexFromTiles } from './offline-search-index.js';

self.addEventListener('message', (event) => {
  const message = event && event.data;
  if (!message || message.type !== 'build') return;
  const { requestId } = message;
  try {
    const index = buildIndexFromTiles({
      regionId: message.regionId,
      bounds: message.bounds || null,
      zoom: message.zoom || null,
      tiles: message.tiles || [],
    });
    self.postMessage({ type: 'index', requestId, index });
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId,
      message: (err && err.message) || 'The index could not be built.',
    });
  }
});
