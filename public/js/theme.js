// Theme preference and the platform light/dark wiring.
//
// The platform forwards the viewer's resolved theme through the bridge
// (`window.usernode.theme`, and a `usernode:theme-changed` event when they
// change it). `prefers-color-scheme` cannot see that choice inside a
// cross-origin iframe, so it is only the standalone fallback. On top of the
// platform default this app offers its own System / Light / Dark override,
// remembered in localStorage, which wins once the user picks one.
import { setState } from './state.js';

const STORAGE_KEY = 'hm-theme';

export function getThemePreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') {
      return value;
    }
  } catch {
    /* storage can be refused in some frames; fall through to the default */
  }
  return 'system';
}

function resolve(preference) {
  if (preference === 'light' || preference === 'dark') return preference;
  const platform = window.usernode && window.usernode.theme;
  if (platform === 'light' || platform === 'dark') return platform;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyTheme(preference = getThemePreference()) {
  const theme = resolve(preference);
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  setState({ themePreference: preference });
  return theme;
}

export function setThemePreference(preference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* non-fatal: the choice just will not persist this session */
  }
  applyTheme(preference);
}

export function initTheme() {
  applyTheme();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => applyTheme());
  window.addEventListener('usernode:theme-changed', () => applyTheme());
}
