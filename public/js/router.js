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
// A query after the screen name (`#/community?view=popular`) is screen state,
// read with hashParams(); it does not change which screen opens.
export function parseHash() {
  const raw = decodeURIComponent(
    window.location.hash.replace(/^#\/?/, '').split('?')[0],
  ).replace(/\/+$/, '');
  return routes.has(raw) ? raw : 'home';
}

export function hashParams() {
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
}

// Rewrite the current screen's hash query without a navigation (no
// hashchange, so the screen is not re-rendered).
export function replaceHashParams(params) {
  const name = parseHash();
  const query = new URLSearchParams(params).toString();
  history.replaceState(null, '', hashFor(name) + (query ? '?' + query : ''));
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
