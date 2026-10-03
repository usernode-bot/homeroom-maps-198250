// Profile — who is signed in, what they have contributed, and the app's
// preferences. If the identity fetch fails, the screen stays usable: the
// preference controls still render, and the identity area shows the shared
// error state with a Try again action.
//
// Phase 7 added two cards, both additive and both built from the existing
// pieces: Activity (the person's own contribution, proposal and vote counts,
// read from /api/profile) and Saved places (the real saved-place count and a
// link into the Saved screen). No existing card was rewritten; the Language
// and Units cards remain Phase 9's.
import { el } from '../components/dom.js';
import { card } from '../components/card.js';
import { button } from '../components/button.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { spinner } from '../components/loading.js';
import { setState } from '../state.js';
import { fetchMe, apiGet } from '../api.js';
import { hasToken } from '../auth.js';
import * as router from '../router.js';
import { getThemePreference, setThemePreference } from '../theme.js';
import {
  t,
  getLanguagePreference,
  setLanguage,
  getUnitsPreference,
  setAppUnits,
} from '../i18n/index.js';

const THEME_OPTIONS = [
  { value: 'system', label: () => t('theme.system') },
  { value: 'light', label: () => t('theme.light') },
  { value: 'dark', label: () => t('theme.dark') },
];

const LANGUAGE_OPTIONS = [
  // Languages are always listed in their own endonym, never translated.
  { value: 'system', label: () => t('lang.system') },
  { value: 'en', label: () => 'English' },
  { value: 'id', label: () => 'Bahasa Indonesia' },
];

const UNITS_OPTIONS = [
  { value: 'system', label: () => t('lang.system') },
  { value: 'metric', label: () => t('units.metric') },
  { value: 'imperial', label: () => t('units.imperial') },
];

export async function render(ctx) {
  let me = null;
  let loadError = null;
  let signedOut = false;
  if (hasToken()) {
    try {
      me = await fetchMe();
      setState({ user: me, locale: me.locale || null });
    } catch (err) {
      loadError = err;
    }
  } else {
    // Opened without a platform token (standalone or offline). There is no
    // identity to fetch; say so plainly instead of requesting one.
    signedOut = true;
  }

  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.profile') }),
    loadError
      ? errorState({
          title: t('profile.loadError'),
          description: loadError.message || t('common.tryAgain'),
          onRetry: () => render(ctx),
        })
      : card([
          el('p', {
            class: 'text-xs font-medium uppercase tracking-wide text-muted',
            text: t('profile.signedInAs'),
          }),
          el('p', {
            class: 'mt-1 text-lg font-semibold text-ink',
            text: signedOut ? t('profile.notSignedIn') : (me && me.username) || '—',
          }),
          el('p', {
            class: 'mt-1 text-sm text-muted leading-relaxed',
            text: signedOut ? t('profile.signedOutNote') : t('profile.signedInNote'),
          }),
        ]),
    // Phase 7: real activity and saved places, loaded from the server in one
    // request. Both are skipped entirely when there is nobody signed in.
    ...(signedOut || loadError ? [] : profileCards()),
    themeCard(),
    languageCard(),
    unitsCard(),
    tripsCard(),
    offlineAreasCard(),
    emptyState({
      title: t('profile.moreSoonTitle'),
      description: t('profile.moreSoonBody'),
    }),
  );
}

// Trips — the Phase 10 trip planner entry. There is deliberately no sixth
// bottom-nav tab: this card is the route in, and #/trips is deep-linkable.
function tripsCard() {
  const c = card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('nav.trips') }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: t('profile.tripsBody'),
    }),
    el('div', { class: 'mt-3' }, [
      button(t('trips.open'), {
        variant: 'secondary',
        attrs: { dataset: { openTrips: 'true' } },
        onClick: () => router.navigate('trips'),
      }),
    ]),
  ]);
  return c;
}

// Offline Areas — the Phase 12A entry. Same shape as the Trips card: a
// title, one line of context, and the way in. #/offline-areas is
// deep-linkable like every other sub-screen.
function offlineAreasCard() {
  return card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('profile.offlineTitle') }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: t('profile.offlineBody'),
    }),
    el('div', { class: 'mt-3' }, [
      button(t('offline.open'), {
        variant: 'secondary',
        attrs: { dataset: { openOfflineAreas: 'true' } },
        onClick: () => router.navigate('offline-areas'),
      }),
    ]),
  ]);
}

// Both Phase 7 cards are filled from ONE request to /api/profile: the
// activity counts and the saved-place count come from the same read model, so
// the screen asks once. Each card still owns its own loading and error state.
function profileCards() {
  const request = apiGet('/api/profile');
  return [activityCard(request), savedCard(request)];
}

// The person's own activity: the real counts from /api/profile (their own
// proposals — drafts included, since they are the author — and their votes).
// Starts as a loading row and becomes either the counts or a short error line
// with no invented numbers.
function activityCard(request) {
  const body = el('div', { class: 'mt-3 flex flex-col gap-2', dataset: { profileActivity: 'true' } }, [
    loadingRow(),
  ]);
  const cardEl = card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('profile.activity') }),
  ]);
  cardEl.appendChild(body);

  request
    .then((data) => {
      const contributions = data && data.contributions ? data.contributions : {};
      const votes = data && data.votes ? data.votes : {};
      body.replaceChildren(
        statRow(t('profile.proposals'), contributions.proposals || 0),
        statRow(t('profile.implemented'), contributions.implemented || 0),
        statRow(t('profile.votes'), votes.votes || 0),
        el('p', { class: 'text-xs text-muted leading-relaxed', text: t('profile.activityBody') }),
      );
    })
    .catch((err) => {
      body.replaceChildren(
        el('p', { class: 'text-sm text-muted', text: (err && err.message) || t('profile.activityError') }),
      );
    });
  return cardEl;
}

function statRow(label, value) {
  return el('div', { class: 'flex items-baseline justify-between gap-4' }, [
    el('p', { class: 'text-sm text-muted', text: label }),
    el('p', { class: 'text-sm font-semibold tabular-nums text-ink', text: String(value) }),
  ]);
}

function loadingRow() {
  return el('div', { class: 'flex items-center gap-3', role: 'status' }, [
    spinner(),
    el('p', { class: 'text-sm text-muted', text: t('common.loading') }),
  ]);
}

// Saved places: the real count plus the way in. The count is a number the
// server counted; the button opens the Saved screen.
function savedCard(request) {
  const body = el('div', { class: 'mt-3 flex flex-col gap-2', dataset: { profileSaved: 'true' } }, [
    loadingRow(),
  ]);
  const cardEl = card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('profile.savedTitle') }),
  ]);
  cardEl.appendChild(body);

  request
    .then((data) => {
      const count = data && data.savedPlaces ? data.savedPlaces.count : 0;
      body.replaceChildren(
        el('p', {
          class: 'text-sm text-muted',
          text: count === 1 ? t('profile.savedCountOne') : t('profile.savedCount', { count }),
        }),
        button(t('profile.openSaved'), {
          variant: 'secondary',
          class: 'self-start',
          attrs: { 'data-open-saved': 'true' },
          onClick: () => router.navigate('saved'),
        }),
      );
    })
    .catch((err) => {
      body.replaceChildren(
        el('p', { class: 'text-sm text-muted', text: (err && err.message) || t('profile.activityError') }),
      );
    });
  return cardEl;
}

function themeCard() {
  const cardEl = card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('profile.appearance') }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: t('profile.appearanceBody'),
    }),
  ]);
  // The group is rebuilt in place on a change, so only the pressed state
  // updates and the card is never re-nested.
  const slot = el('div', { class: 'contents' }, [themeGroup()]);
  cardEl.appendChild(slot);

  function rerender(option) {
    setThemePreference(option);
    slot.replaceChildren(themeGroup());
    wire(slot.firstChild);
  }

  function wire(group) {
    group.querySelectorAll('[data-theme-option]').forEach((node) => {
      node.addEventListener('click', () => rerender(node.dataset.themeOption));
    });
  }

  wire(slot.firstChild);
  return cardEl;
}

// Language — the Phase 9 preference. Choosing applies immediately (the shell
// re-renders the current screen through the i18n change subscriber) and
// persists on the device like the theme preference does. 'System' returns
// control to the Homeroom-level and device settings.
function languageCard() {
  const cardEl = card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('profile.language') }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: t('profile.languageBody'),
    }),
  ]);
  const slot = el('div', { class: 'contents' }, [segmentedGroup({
    options: LANGUAGE_OPTIONS,
    current: getLanguagePreference(),
    ariaLabel: t('profile.languageGroup'),
    attr: 'langOption',
  })]);
  cardEl.appendChild(slot);

  function rerender(option) {
    setLanguage(option);
    slot.replaceChildren(segmentedGroup({
      options: LANGUAGE_OPTIONS,
      current: getLanguagePreference(),
      ariaLabel: t('profile.languageGroup'),
      attr: 'langOption',
    }));
    wire(slot.firstChild);
  }

  function wire(group) {
    group.querySelectorAll('[data-lang-option]').forEach((node) => {
      node.addEventListener('click', () => rerender(node.dataset.langOption));
    });
  }

  wire(slot.firstChild);
  return cardEl;
}

// Units — metric or imperial for distances; 'System' follows the device
// region (metric everywhere except the documented imperial-first regions).
function unitsCard() {
  const cardEl = card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('profile.units') }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: t('profile.unitsBody'),
    }),
  ]);
  const slot = el('div', { class: 'contents' }, [segmentedGroup({
    options: UNITS_OPTIONS,
    current: getUnitsPreference(),
    ariaLabel: t('profile.unitsGroup'),
    attr: 'unitsOption',
  })]);
  cardEl.appendChild(slot);

  function rerender(option) {
    setAppUnits(option);
    slot.replaceChildren(segmentedGroup({
      options: UNITS_OPTIONS,
      current: getUnitsPreference(),
      ariaLabel: t('profile.unitsGroup'),
      attr: 'unitsOption',
    }));
    wire(slot.firstChild);
  }

  function wire(group) {
    group.querySelectorAll('[data-units-option]').forEach((node) => {
      node.addEventListener('click', () => rerender(node.dataset.unitsOption));
    });
  }

  wire(slot.firstChild);
  return cardEl;
}

// The segmented pill control the Appearance card introduced. Labels resolve
// through the i18n layer at render time; the pressed state is rebuilt in
// place, never re-nested.
function segmentedGroup({ options, current, ariaLabel, attr }) {
  return el(
    'div',
    {
      class: 'mt-3 flex gap-1 rounded-pill bg-surface-raised p-1',
      role: 'group',
      'aria-label': ariaLabel,
    },
    options.map((option) => {
      const active = option.value === current;
      return el(
        'button',
        {
          type: 'button',
          class: [
            'flex-1 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            active ? 'bg-brand text-brand-contrast' : 'text-muted hover:text-ink',
          ].join(' '),
          dataset: { [attr]: option.value },
          'aria-pressed': active ? 'true' : 'false',
        },
        [option.label()],
      );
    }),
  );
}

function themeGroup() {
  const current = getThemePreference();
  return el(
    'div',
    {
      class: 'mt-3 flex gap-1 rounded-pill bg-surface-raised p-1',
      role: 'group',
      'aria-label': t('profile.themeGroup'),
    },
    THEME_OPTIONS.map((option) => {
      const active = option.value === current;
      return el(
        'button',
        {
          type: 'button',
          class: [
            'flex-1 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            active ? 'bg-brand text-brand-contrast' : 'text-muted hover:text-ink',
          ].join(' '),
          dataset: { themeOption: option.value },
          'aria-pressed': active ? 'true' : 'false',
        },
        [option.label()],
      );
    }),
  );
}
