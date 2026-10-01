// A very small observable store for the few values the shell shares across
// screens (the signed-in user, the resolved locale, the theme preference,
// public config). No framework, no persistence layer — each screen owns its
// own data and this holds only what is genuinely cross-screen.
const state = {
  user: null,
  locale: null,
  themePreference: 'system',
  config: null,
};

const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(patch) {
  Object.assign(state, patch);
  const snapshot = getState();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.error(err);
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
