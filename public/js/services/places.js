// Places service — INTERFACE ONLY. Place search and points of interest arrive
// with the map in a later stage; the server route /api/places answers 501.
export async function search(_query) {
  return { items: [], notImplemented: true };
}

export async function getPlace(_id) {
  return null;
}
