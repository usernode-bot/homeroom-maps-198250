// Guarded device-local preference storage — the shared implementation of the
// pattern theme.js already established (`hm-theme`): localStorage inside a
// try/catch, because a cross-origin or embedded frame can refuse storage, in
// which case the preference simply degrades to per-session default.
//
// This is the app's ONE preference system extended, not a second one.
// theme.js keeps its own working key untouched this phase; migrating it onto
// this helper is deferred to avoid churning a working module.

// Read a stored preference, returning `fallback` unless the stored value is
// one of `allowed`. Anything else (missing, refused storage, a stale or
// unsupported value) falls back safely — the same guard theme.js applies.
export function readPref(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value != null && allowed.includes(value)) return value;
  } catch {
    /* storage refused in some frames; fall through to the default */
  }
  return fallback;
}

// Write a preference; a refused write is non-fatal (the choice just does not
// persist this session), exactly like the theme preference.
export function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}
