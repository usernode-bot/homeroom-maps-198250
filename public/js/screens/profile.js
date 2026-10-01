// Profile — the one tab with something real to do this stage: it shows who is
// signed in, explains that sign-in is handled by Homeroom, and offers the
// theme override. If the identity fetch fails, the screen stays usable: the
// theme control and the placeholders still render, and the identity area shows
// the shared error state with a Try again action.
import { el } from '../components/dom.js';
import { card } from '../components/card.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { placeholderPanel } from '../components/placeholder-panel.js';
import { setState } from '../state.js';
import { fetchMe } from '../api.js';
import { hasToken } from '../auth.js';
import { getThemePreference, setThemePreference } from '../theme.js';

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
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
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: 'Profile' }),
    loadError
      ? errorState({
          title: 'We could not load your profile',
          description: loadError.message || 'Please try again.',
          onRetry: () => render(ctx),
        })
      : card([
          el('p', {
            class: 'text-xs font-medium uppercase tracking-wide text-muted',
            text: 'Signed in as',
          }),
          el('p', {
            class: 'mt-1 text-lg font-semibold text-ink',
            text: signedOut ? 'Not signed in' : (me && me.username) || '—',
          }),
          el('p', {
            class: 'mt-1 text-sm text-muted leading-relaxed',
            text: signedOut
              ? 'Open Homeroom Maps inside Homeroom to sign in. Sign-in is handled by Homeroom, not by this app.'
              : 'You are signed in through Homeroom. There is no separate Homeroom Maps account.',
          }),
        ]),
    themeCard(),
    placeholderPanel({
      title: 'Saved places',
      description: 'Saved places and trip planning are coming soon.',
    }),
    emptyState({
      title: 'More soon',
      description: 'Contribution history and notification settings will appear here.',
    }),
  );
}

function themeCard() {
  const cardEl = card([
    el('p', { class: 'text-base font-semibold text-ink', text: 'Appearance' }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: 'Follow the platform theme, or set this app to Light or Dark.',
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

function themeGroup() {
  const current = getThemePreference();
  return el(
    'div',
    {
      class: 'mt-3 flex gap-1 rounded-pill bg-surface-raised p-1',
      role: 'group',
      'aria-label': 'Theme',
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
        [option.label],
      );
    }),
  );
}
