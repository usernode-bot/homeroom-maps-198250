// App bootstrap. Wires the shell, the router and the global error boundary:
// a screen that throws (or an API call that fails) renders the shared error
// state with a Try again action instead of a blank page.
import { el } from './components/dom.js';
import { renderShell } from './components/app-shell.js';
import { loading } from './components/loading.js';
import { errorState } from './components/error-state.js';
import { getState, setState } from './state.js';
import { fetchConfig, fetchMe, onPendingChange } from './api.js';
import { hasToken } from './auth.js';
import * as router from './router.js';
import * as theme from './theme.js';
import * as i18n from './i18n/index.js';
import * as home from './screens/home.js';
import * as discover from './screens/discover.js';
import * as directions from './screens/directions.js';
import * as community from './screens/community.js';
import * as profile from './screens/profile.js';
import * as saved from './screens/saved.js';

router.register('home', home);
router.register('discover', discover);
router.register('directions', directions);
router.register('community', community);
router.register('profile', profile);
router.register('saved', saved);

const root = document.getElementById('app');
let currentName = 'home';
let routeToken = 0;

// Global error boundary: anything thrown while rendering or loading a screen
// lands here.
function showError(err) {
  const content = root.querySelector('[data-screen-host]');
  if (!content) return;
  content.replaceChildren(
    errorState({
      title: i18n.t('error.screenTitle'),
      description:
        (err && err.message) ||
        i18n.t('error.screenBody'),
      onRetry: () => renderScreen(currentName, true),
    }),
  );
}

// The signed-in user's name for the top bar; best-effort, never fatal.
async function loadMeta() {
  try {
    const config = await fetchConfig();
    setState({ config });
    // Only ask who is signed in when the shell actually gave us a token.
    // Without one the server is right to answer 401, and a request that is
    // expected to fail is noise, not a real error.
    if (!getState().user && hasToken()) {
      try {
        const me = await fetchMe();
        setState({ user: me });
        // The platform's own locale claim: the i18n layer follows it only
        // when the user has no in-app language override.
        i18n.notePlatformLocale(me.locale);
      } catch {
        /* the shell still works without the header name */
      }
    }
  } catch {
    /* config is best-effort; screens that need it read it defensively */
  }
}

async function renderScreen(name, force = false) {
  if (!force && name === currentName && root.querySelector('[data-screen-host]')) {
    return;
  }
  currentName = name;
  routeToken += 1;
  const token = routeToken;

  root.removeAttribute('data-ready');
  const content = renderShell(root, {
    activeName: name,
    subtitle: (getState().user && getState().user.username) || '',
  });
  content.replaceChildren(loading());

  const screen = router.get(name);
  try {
    await loadMeta();
    if (token !== routeToken) return; // a newer navigation won
    await screen.render({ content, name });
    if (token !== routeToken) return;
    if (getState().user && getState().user.username) {
      const bar = root.querySelector('header [data-username]');
      if (bar) bar.textContent = getState().user.username;
    }
    root.setAttribute('data-ready', 'true');
  } catch (err) {
    console.error(err);
    if (token !== routeToken) return;
    showError(err);
  }
}

async function boot() {
  theme.initTheme();
  // i18n first: the initial locale is applied (html lang/dir, bundles) before
  // the first render so no screen paints in the wrong language. The English
  // bundle is static, so this adds no network round-trip on first paint.
  await i18n.init();
  // A language switch re-renders the current screen in place, the same way a
  // navigation does — no reload.
  i18n.onChange(() => renderScreen(currentName, true));
  root.replaceChildren(loading({ label: i18n.t('app.starting') }));
  router.start((name) => renderScreen(name, true));
}

// The shell announces a pending request so global loading stays honest even
// for actions outside a screen's own load.
onPendingChange((pending) => {
  document.documentElement.toggleAttribute('data-net-pending', pending);
});

boot();
