// Saved places service — INTERFACE ONLY. Saved places and trip planning arrive
// in a later stage; the server route /api/saved answers 501.
export async function list() {
  return { items: [], notImplemented: true };
}

export async function save(_place) {
  throw new Error('Saved places are not built yet.');
}
