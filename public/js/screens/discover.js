// Discover — the Places screen (Phase 3). The flow is search-driven, per the
// documented Search→Places interface (services/places-model.js):
//
//   search (Phase 2's real worldwide search) -> Place Cards (the one reusable
//   card) -> Place Detail view (screens/place-detail.js), which enriches
//   through the server's PlaceService and renders honest per-field states.
//
// The search input reuses the shared search bar component and the search
// service's public fetcher (services/search.js) — both are read, not
// modified; this module owns only the small debounce/abort machine below.
// No place provider is connected yet, so detail depth (photos, hours,
// contact, rating) renders "Not available" states, never invented data.
import { el } from '../components/dom.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { spinner } from '../components/loading.js';
import { createSearchBar } from '../components/search/search-bar.js';
import { createPlaceCard } from '../components/place/place-card.js';
import { DEBOUNCE_MS, MIN_QUERY_LENGTH, fetchSearch, isOffline } from '../services/search.js';
import { fetchPlace } from '../services/places.js';
import { placeFromSearchResult } from '../services/places-model.js';
import { createPlaceDetailSession } from '../services/place-detail.js';
import { createPlaceDetailView } from './place-detail.js';
import { t } from '../i18n/index.js';

function isAbort(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

export async function render(ctx) {
  // ---- search state (list mode) ----
  let controller = null;
  let debounceTimer = null;
  let generation = 0;
  let lastResults = []; // the last answer's mapped places, for returning from a detail
  let mode = 'list'; // list | detail

  const bar = createSearchBar({
    onInput: (value) => {
      bar.update({ query: value, open: false, highlighted: -1 });
      schedule(value);
    },
    onFocus: () => {},
    onBlur: () => {},
    onKeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = bar.input.value.trim();
        if (q.length >= MIN_QUERY_LENGTH) run(q);
      }
    },
    onClear: () => {
      bar.update({ query: '', open: false, highlighted: -1 });
      cancelPending();
      renderIdle();
      bar.input.focus();
    },
  });

  const searchHost = el('div', { class: 'flex flex-col gap-1.5', dataset: { placesSearch: 'true' } }, [
    bar.root,
  ]);

  function cancelPending() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (controller) controller.abort();
    controller = null;
  }

  function schedule(value) {
    cancelPending();
    const q = value.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      renderIdle();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      run(q);
    }, DEBOUNCE_MS);
  }

  async function run(q) {
    cancelPending();
    generation += 1;
    const gen = generation;
    controller = new AbortController();
    renderLoading();
    try {
      const results = await fetchSearch(q, { signal: controller.signal });
      if (gen !== generation) return; // a newer query won
      renderResults(results);
    } catch (err) {
      if (isAbort(err) || gen !== generation) return;
      renderError(err, q);
    }
  }

  // ---- list-mode views ----

  function renderIdle() {
    if (mode !== 'list') return;
    lastResults = [];
    listHost.replaceChildren(
      emptyState({
        title: t('discover.idleTitle'),
        description: t('discover.idleBody'),
      }),
    );
  }

  function renderLoading() {
    if (mode !== 'list') return;
    listHost.replaceChildren(
      el('div', { class: 'flex items-center gap-3 py-2', role: 'status' }, [
        spinner(),
        el('p', { class: 'text-sm text-muted', text: t('search.searching') }),
      ]),
    );
  }

  function renderResults(results) {
    if (mode !== 'list') return;
    const places = (Array.isArray(results) ? results : [])
      .map((result) => placeFromSearchResult(result))
      .filter(Boolean);
    renderPlaces(places);
  }

  // Renders already-mapped places. Kept separate from renderResults so
  // returning from a detail re-renders the mapped places as they are, without
  // running them through the adapter a second time.
  function renderPlaces(places) {
    if (mode !== 'list') return;
    lastResults = places;
    if (!places.length) {
      listHost.replaceChildren(
        emptyState({
          title: t('search.noResultsTitle'),
          description: t('discover.noResultsBody'),
        }),
      );
      return;
    }
    // Offline results name the downloaded area they came from and, when the
    // device is actually connected, say the fallback happened; the manifest's
    // attribution is shown exactly as it is stored.
    const first = places[0];
    const notices = [];
    if (first && first.offline) {
      if (!isOffline()) {
        notices.push(
          el('p', {
            class: 'text-[11px] text-muted',
            dataset: { offlineNotice: 'degraded' },
            text: t('offline.searchDegraded', { region: first.regionName || '' }),
          }),
        );
      }
      notices.push(
        el('p', {
          class: 'text-[11px] text-muted',
          dataset: { offlineScope: 'true' },
          text: t('offline.searchScope', { region: first.regionName || '' }),
        }),
      );
      if (first.attribution) {
        notices.push(
          el('p', {
            class: 'text-[11px] text-muted',
            dataset: { offlineAttribution: 'true' },
            text: t('offline.searchAttribution', { attribution: first.attribution }),
          }),
        );
      }
    }
    listHost.replaceChildren(
      el(
        'div',
        { class: 'flex flex-col gap-2', dataset: { placeList: 'true' } },
        [
          ...notices,
          ...places.map((place) => createPlaceCard(place, { onSelect: openDetail })),
        ],
      ),
    );
  }

  function renderError(err, q) {
    if (mode !== 'list') return;
    const rateLimited = err && err.code === 'rate_limited';
    // Offline, the honest unavailable states have their own copy, chosen by
    // the typed reason the offline service carries. Online errors are
    // untouched.
    const offlineReason =
      err && err.code === 'offline_unavailable' ? err.reason : null;
    const offlineCopy = offlineReason && {
      no_regions: { title: t('offline.searchNoAreasTitle'), body: t('offline.searchNoAreasBody') },
      unsupported_browser: {
        title: t('offline.searchUnsupportedTitle'),
        body: t('offline.searchUnsupportedBody'),
      },
      disabled: {
        title: t('offline.searchDisabledTitle'),
        body: t('offline.searchDisabledBody'),
      },
    }[offlineReason];
    if (offlineCopy) {
      listHost.replaceChildren(
        emptyState({
          title: offlineCopy.title,
          description: offlineCopy.body,
        }),
      );
      return;
    }
    listHost.replaceChildren(
      errorState({
        title: rateLimited ? t('search.errorBusy') : t('search.errorUnavailable'),
        description:
          (err && err.message) ||
          t('search.errorFallback'),
        onRetry: () => run(q),
      }),
    );
  }

  // ---- detail mode ----

  function openDetail(place) {
    if (!place || !place.id) return;
    mode = 'detail';
    cancelPending();
    const session = createPlaceDetailSession({
      place,
      fetchDetails: (id) => fetchPlace(id),
    });
    const view = createPlaceDetailView({ session, onBack: showList });
    session.subscribe(() => view.update(session.getState()));
    ctx.content.replaceChildren(view.root);
    session.start();
  }

  function showList() {
    mode = 'list';
    ctx.content.replaceChildren(searchHost, listHost);
    if (lastResults.length) renderPlaces(lastResults);
    else renderIdle();
  }

  const listHost = el('div', { class: 'flex flex-col gap-2', dataset: { placesListHost: 'true' } });

  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.discover') }),
    searchHost,
    listHost,
  );
  renderIdle();
}