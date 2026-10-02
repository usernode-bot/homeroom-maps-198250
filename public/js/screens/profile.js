// Profile — the one tab with something real to do this stage: it shows who is
// signed in, explains that sign-in is handled by Homeroom, and offers the
// theme, language and units preferences. If the identity fetch fails, the
// screen stays usable: the preference controls and the placeholders still
// render, and the identity area shows the shared error state with a Try again
// action.
//
// The Language and Units cards are Phase 9's only change here: they follow the
// Appearance card's pattern exactly (same card, same segmented pill group,
// rebuilt in place on selection) and call only the i18n layer.
import { el } from '../components/dom.js';
import { card } from '../components/card.js';
import { button } from '../components/button.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { placeholderPanel } from '../components/placeholder-panel.js';
import { setState } from '../state.js';
import { fetchMe } from '../api.js';
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
    themeCard(),
    languageCard(),
    unitsCard(),
    tripsCard(),
    placeholderPanel({
      title: t('profile.savedTitle'),
      description: t('profile.savedBody'),
    }),
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
