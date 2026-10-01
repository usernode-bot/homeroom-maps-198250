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

// The screen named by the current fragment, or Home for an unknown/empty one.
export function parseHash() {
  const raw = decodeURIComponent(
    window.location.hash.replace(/^#\/?/, ''),
  ).replace(/\/+$/, '');
  return routes.has(raw) ? raw : 'home';
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
