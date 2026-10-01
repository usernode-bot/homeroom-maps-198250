// Directions service — INTERFACE ONLY. Routing and navigation arrive in a
// later stage; the server route /api/directions answers 501.
export async function route(_from, _to, _mode) {
  return { routes: [], notImplemented: true };
}
