// Hash router. Screens live at `#/`, `#/discover`, `#/directions`,
// `#/community`, `#/profile`. Hash routing is chosen because the server
// already serves the HTML shell from an auth-gated catch-all for every GET
// path, so no new server route is needed, the `?token=` deep-link pass-through
// is untouched, and reload/back keep working. Swapping to path routing later
// is a change inside this file, not a re-architecture.
const routes = new Map();
let onChange = null;

export function register(name, screen) {
  routes.set(name, screen);
}

export function names() {
  return [...routes.keys()];
}

export function get(name) {
  return routes.get(name);
}

export function hashFor(name) {
  return '#/' + (name === 'home' ? '' : name);
}

// Split the fragment into its route path and its query part, before any
// decoding, so an encoded `?to=Berlin%2C52.52%2C13.405` hand-off keeps its
// encoded separators intact (the Place Detail -> Directions deep link).
function splitHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  return q < 0 ? [raw, ''] : [raw.slice(0, q), raw.slice(q + 1)];
}

// The screen named by the current fragment, or Home for an unknown/empty one.
// A `?query` on the fragment never changes which screen it names.
export function parseHash() {
  const [path] = splitHash();
  const clean = decodeURIComponent(path).replace(/\/+$/, '');
  return routes.has(clean) ? clean : 'home';
}

// The current fragment's query, decoded like a URL query string. Screens read
// their deep-link parameters from here instead of re-parsing the hash.
export function hashParams() {
  const [, query] = splitHash();
  return new URLSearchParams(query);
}

export function navigate(name) {
  const hash = hashFor(name);
  if (window.location.hash === hash) {
    if (onChange) onChange(parseHash());
    return;
  }
  window.location.hash = hash;
}

export function start(handler) {
  onChange = handler;
  window.addEventListener('hashchange', () => onChange(parseHash()));
  if (!window.location.hash) {
    history.replaceState(null, '', hashFor(parseHash()));
  }
  onChange(parseHash());
}
