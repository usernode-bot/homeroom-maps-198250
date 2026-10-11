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
import { t } from '../../i18n/index.js';
import { formatAddress } from '../../i18n/address.js';
import { isOffline, offlineScope } from '../../services/search.js';

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

// The Offline marker every downloaded result carries. One shared shape so the
// search row and the Place card render the identical badge.
export function offlineBadge() {
  return el(
    'span',
    {
      class:
        'inline-flex shrink-0 items-center rounded-pill border border-line bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted',
      dataset: { offlineBadge: 'true' },
      text: t('offline.searchBadge'),
    },
  );
}

// One suggestion/recent row: name on top, detail line beneath. Exported so
// the Directions screen's location fields reuse the exact same row markup
// and interaction (the panel there is built on the same search session).
export function resultRow({ optionId, iconName, result, active, onSelect }) {
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
        el('span', { class: 'flex items-center gap-1.5' }, [
          el('span', { class: 'block truncate text-sm font-medium text-ink', text: result.name }),
          result.offline ? offlineBadge() : null,
        ]),
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
        el('p', { class: 'text-xs font-medium uppercase tracking-wide text-muted', text: t('search.recentTitle') }),
        el(
          'button',
          {
            type: 'button',
            class: 'text-xs font-medium text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
            dataset: { searchClearRecents: 'true' },
          },
          [t('search.clear')],
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
        text: t('search.idleHint'),
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
    el('p', { class: 'text-sm text-muted', text: t('search.searching') }),
  ]);
}

function resultsView(state, { onSelect }) {
  const listbox = el(
    'div',
    { id: 'hm-search-listbox', role: 'listbox', 'aria-label': t('search.listboxLabel') },
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
  const first = state.results[0] || null;
  const offline = Boolean(first && first.offline);
  // Offline results name the area they came from and carry the manifest's
  // own attribution. When the device is actually connected (a degraded
  // fallback after a network failure) say so instead of implying it is the
  // normal online answer.
  const notices = [];
  if (offline) {
    if (!isOffline()) {
      notices.push(
        el('p', {
          class: 'px-4 pb-1 pt-2 text-[11px] text-muted',
          dataset: { offlineNotice: 'degraded' },
          text: t('offline.searchDegraded', { region: first.regionName || '' }),
        }),
      );
    }
    notices.push(
      el('p', {
        class: 'px-4 pb-1 pt-2 text-[11px] text-muted',
        dataset: { offlineScope: 'true' },
        text: t('offline.searchScope', { region: first.regionName || '' }),
      }),
    );
    if (first.attribution) {
      notices.push(
        el('p', {
          class: 'px-4 pb-2.5 pt-0.5 text-[11px] text-muted',
          dataset: { offlineAttribution: 'true' },
          text: t('offline.searchAttribution', { attribution: first.attribution }),
        }),
      );
    }
  } else if (OSM_PROVIDERS.has(first && first.provider)) {
    notices.push(
      el('p', {
        class: 'px-4 pb-2.5 pt-1 text-[11px] text-muted',
        text: t('search.osmLine'),
      }),
    );
  }
  return el('div', { class: SCROLL_CLASSES }, [listbox, ...notices]);
}

function noResultsView(state) {
  // role="status" so assistive tech announces the state, like the loading
  // spinner and the error alert already do. An offline empty answer names the
  // area it searched, so the copy never reads like a worldwide miss.
  const scope = offlineScope();
  const offline = Boolean(scope && scope.regionName);
  return el('div', { role: 'status', dataset: offline ? { offlineNoResults: 'true' } : {} }, [
    emptyState({
      title: t('search.noResultsTitle'),
      description: offline
        ? t('offline.searchNoResults', { query: state.query.trim(), region: scope.regionName })
        : t('search.noResults', { query: state.query.trim() }),
    }),
  ]);
}

function errorView(state, { onRetry }) {
  // A 429 from the app's own rate limiter is a busy moment, not an outage;
  // say so instead of the generic failure title.
  const rateLimited = state.error && state.error.code === 'rate_limited';
  // Offline, the honest unavailable states have their own copy, chosen by the
  // typed reason the offline service carries. This reuses the existing error
  // branch; online errors are untouched.
  const offlineReason =
    state.error && state.error.code === 'offline_unavailable' ? state.error.reason : null;
  if (offlineReason) {
    const copy = {
      no_regions: { title: t('offline.searchNoAreasTitle'), body: t('offline.searchNoAreasBody') },
      unsupported_browser: {
        title: t('offline.searchUnsupportedTitle'),
        body: t('offline.searchUnsupportedBody'),
      },
      disabled: {
        title: t('offline.searchDisabledTitle'),
        body: t('offline.searchDisabledBody'),
      },
    }[offlineReason] || null;
    if (copy) {
      return el('div', { dataset: { offlineUnavailable: offlineReason } }, [
        emptyState({
          title: copy.title,
          description: copy.body,
          action: offlineReason === 'no_regions'
            ? el('a', {
                href: '#/offline-areas',
                class:
                  'inline-flex items-center justify-center gap-2 rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                text: t('offline.open'),
              })
            : null,
        }),
      ]);
    }
  }
  return el('div', {}, [
    errorState({
      title: rateLimited ? t('search.errorBusy') : t('search.errorUnavailable'),
      description:
        (state.error && state.error.message) ||
        t('search.errorFallback'),
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
  // Address line: composed from the structured parts in the country's
  // ordering convention (i18n/address.js) when they exist, else exactly the
  // provider's preformatted line, as before. Coordinates stay dot-decimal:
  // that is the notation people paste into other map tools.
  const composedLine = formatAddress(place.address, {
    countryCode: place.address && place.address.countryCode,
  });
  const line = composedLine || place.addressLine || null;
  const cardEl = card(
    [
      el('div', { class: 'flex items-start justify-between gap-3' }, [
        el('p', { class: 'text-xs font-medium uppercase tracking-wide text-muted', text: t('place.selected') }),
        el(
          'button',
          {
            type: 'button',
            class: 'shrink-0 text-sm font-medium text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
            dataset: { searchRemoveSelected: 'true' },
            'aria-label': t('place.remove'),
          },
          [t('place.remove')],
        ),
      ]),
      el('p', { class: 'mt-1 text-lg font-semibold text-ink', text: place.name }),
      place.localName ? el('p', { class: 'text-sm text-muted', text: place.localName }) : null,
      el('p', { class: 'mt-0.5 text-sm text-muted', text: place.detail || '' }),
      line && line !== place.detail
        ? el('p', { class: 'text-sm text-ink', text: line })
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