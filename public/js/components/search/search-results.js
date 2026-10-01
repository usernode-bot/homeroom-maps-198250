// Search results panel and the Selected place card.
//
// The panel renders the session state the service emits: recent searches
// (with the Clear action) when the input is short, a spinner while loading,
// the suggestion listbox when there are results, the app's empty state on a
// genuinely empty answer, the app's error state with Try again on a failure.
// Every row and action uses the shared UI components; nothing here invents a
// result row — what the server returned is exactly what renders.
//
// Like the search bar, the panel container is created once and its children
// are replaced on each state update. Option buttons use mousedown
// preventDefault so selecting one never blurs the input mid-click.
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { card } from '../card.js';
import { emptyState } from '../empty-state.js';
import { errorState } from '../error-state.js';
import { spinner } from '../loading.js';

// Providers whose data carries the ODbL attribution obligation. The line is
// wired to the result's provider field so a commercial adapter switch (which
// would need its own attribution) updates it automatically.
const OSM_PROVIDERS = new Set(['photon', 'nominatim', 'pelias']);

// The panel's scroll cap: eight to ten rows would otherwise push the Selected
// place card and the map frame off a phone screen. Both scrollable views
// (suggestions and recents) share it.
const SCROLL_CLASSES = 'max-h-80 overflow-y-auto';

function keepFocus(e) {
  e.preventDefault();
}

// One suggestion/recent row: name on top, detail line beneath.
function resultRow({ optionId, iconName, result, active, onSelect }) {
  const row = el(
    'button',
    {
      type: 'button',
      class: [
        'flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors',
        active ? 'bg-surface-raised' : 'hover:bg-surface-raised',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
      ].join(' '),
      role: 'option',
      'aria-selected': active ? 'true' : 'false',
      ...(optionId ? { id: optionId } : {}),
    },
    [
      icon(iconName, { class: 'mt-0.5 h-4 w-4 shrink-0 text-muted' }),
      el('span', { class: 'min-w-0 flex-1' }, [
        el('span', { class: 'block truncate text-sm font-medium text-ink', text: result.name }),
        el('span', { class: 'block truncate text-xs text-muted', text: result.detail || '' }),
      ]),
    ],
  );
  row.addEventListener('mousedown', keepFocus);
  row.addEventListener('click', () => onSelect(result));
  return row;
}

function recentsView(state, { onRepeat, onClearRecents, onClose }) {
  const children = [];
  if (state.recents.length) {
    children.push(
      el('div', { class: 'flex items-center justify-between px-4 pb-1 pt-3' }, [
        el('p', { class: 'text-xs font-medium uppercase tracking-wide text-muted', text: 'Recent searches' }),
        el(
          'button',
          {
            type: 'button',
            class: 'text-xs font-medium text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
            dataset: { searchClearRecents: 'true' },
          },
          ['Clear'],
        ),
      ]),
    );
    children.push(
      ...state.recents.map((recent, i) =>
        resultRow({
          iconName: 'history',
          result: recent,
          active: false,
          optionId: `hm-search-recent-${i}`,
          onSelect: onRepeat,
        }),
      ),
    );
  } else {
    children.push(
      el('p', {
        class: 'px-4 py-5 text-sm text-muted leading-relaxed',
        text: 'Search countries, cities, streets and places worldwide.',
      }),
    );
  }
  const host = el('div', { class: SCROLL_CLASSES }, children);
  host.querySelector('[data-search-clear-recents]')?.addEventListener('mousedown', keepFocus);
  host.querySelector('[data-search-clear-recents]')?.addEventListener('click', () => {
    onClearRecents();
    onClose();
  });
  return host;
}

function loadingView() {
  return el('div', { class: 'flex items-center gap-3 px-4 py-5' }, [
    spinner(),
    el('p', { class: 'text-sm text-muted', text: 'Searching…' }),
  ]);
}

function resultsView(state, { onSelect }) {
  const listbox = el(
    'div',
    { id: 'hm-search-listbox', role: 'listbox', 'aria-label': 'Suggestions' },
    state.results.map((result, i) =>
      resultRow({
        optionId: `hm-search-opt-${i}`,
        iconName: 'search',
        result,
        active: i === state.highlighted,
        onSelect,
      }),
    ),
  );
  return el('div', { class: SCROLL_CLASSES }, [
    listbox,
    OSM_PROVIDERS.has(state.results[0] && state.results[0].provider)
      ? el('p', {
          class: 'px-4 pb-2.5 pt-1 text-[11px] text-muted',
          text: 'Search data © OpenStreetMap contributors',
        })
      : null,
  ]);
}

function noResultsView(state) {
  // role="status" so assistive tech announces the state, like the loading
  // spinner and the error alert already do.
  return el('div', { role: 'status' }, [
    emptyState({
      title: 'No results',
      description: `No matches for "${state.query.trim()}". Check the spelling or try a different name.`,
    }),
  ]);
}

function errorView(state, { onRetry }) {
  // A 429 from the app's own rate limiter is a busy moment, not an outage;
  // say so instead of the generic failure title.
  const rateLimited = state.error && state.error.code === 'rate_limited';
  return el('div', {}, [
    errorState({
      title: rateLimited ? 'Search is busy right now' : 'Search is unavailable right now',
      description:
        (state.error && state.error.message) ||
        'We could not reach the search service. Try again in a moment.',
      onRetry,
    }),
  ]);
}

export function createSearchPanel({ session }) {
  const root = el('div', {
    class:
      'overflow-hidden rounded-card border border-line bg-surface shadow-sm',
    dataset: { searchPanel: 'true' },
  });

  // The panel only reacts; the session is the single source of truth.
  const actions = {
    onSelect: (result) => session.select(result),
    onRepeat: (recent) => session.repeatRecent(recent),
    onClearRecents: () => session.clearRecents(),
    onClose: () => session.close(),
    onRetry: () => session.retry(),
  };

  function update(state) {
    root.classList.toggle('hidden', !state.open);
    if (!state.open) {
      root.replaceChildren();
      return;
    }
    const phase = session.phase();
    let content;
    if (phase === 'error') content = errorView(state, actions);
    else if (phase === 'loading') content = loadingView();
    else if (phase === 'results') content = resultsView(state, actions);
    else if (phase === 'no-results') content = noResultsView(state);
    else content = recentsView(state, actions); // recents / typing
    root.replaceChildren(content);
  }

  update(session.getState());
  return { root, update };
}

// The card that shows the place a suggestion was chosen for. Until the map
// phase lands this is the honest end of the flow: it never pretends to show
// a map, and "Remove" clears it.
export function selectedPlaceCard({ place, onRemove }) {
  const coords = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
  const cardEl = card(
    [
      el('div', { class: 'flex items-start justify-between gap-3' }, [
        el('p', { class: 'text-xs font-medium uppercase tracking-wide text-muted', text: 'Selected place' }),
        el(
          'button',
          {
            type: 'button',
            class: 'shrink-0 text-sm font-medium text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
            dataset: { searchRemoveSelected: 'true' },
            'aria-label': 'Remove',
          },
          ['Remove'],
        ),
      ]),
      el('p', { class: 'mt-1 text-lg font-semibold text-ink', text: place.name }),
      place.localName ? el('p', { class: 'text-sm text-muted', text: place.localName }) : null,
      el('p', { class: 'mt-0.5 text-sm text-muted', text: place.detail || '' }),
      place.addressLine && place.addressLine !== place.detail
        ? el('p', { class: 'text-sm text-ink', text: place.addressLine })
        : null,
      el('p', { class: 'mt-1 text-xs text-muted', text: coords }),
    ].filter(Boolean),
  );
  const removeBtn = cardEl.querySelector('[data-search-remove-selected]');
  // preventDefault on mousedown keeps the input focused, so closing the
  // panel on blur can never replace this card mid-click and swallow it.
  removeBtn.addEventListener('mousedown', keepFocus);
  removeBtn.addEventListener('click', onRemove);
  return cardEl;
}