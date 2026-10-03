// Place sheet — the search-then-confirm sheet used by both ways a place
// enters a list: the owner ADDING a place, and a viewer SUGGESTING one.
// Search reuses the real search service (fetchSearch + placeFromSearchResult),
// so the places offered here are exactly what Discover offers — nothing is
// invented for the sheet. Results without coordinates are filtered out: the
// server stores a place snapshot and requires coordinates.
import { el } from '../dom.js';
import { button } from '../button.js';
import { spinner } from '../loading.js';
import { present } from '../surface.js';
import { toast } from '../community/parts.js';
import { fetchSearch } from '../../services/search.js';
import { placeFromSearchResult, categoryLabel } from '../../services/places-model.js';
import { hasCoords } from '../../services/saved.js';
import { t } from '../../i18n/index.js';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

function resultRow(place, { onPick }) {
  const subtitle = categoryLabel(place) || place.address || '';
  return el('button', {
    type: 'button',
    class:
      'flex w-full items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
    dataset: { savedPlaceResult: place.id },
    onClick: () => onPick(place),
  }, [
    el('span', { class: 'min-w-0 flex-1' }, [
      el('span', { class: 'block truncate text-sm font-medium text-ink', text: place.name }),
      subtitle
        ? el('span', { class: 'block truncate text-xs text-muted', text: subtitle })
        : null,
    ]),
  ]);
}

// mode: 'add' (owner) or 'suggest' (viewer, with an optional message).
// onConfirm(place, message) runs on the confirm tap; the sheet closes on
// success and stays open with a toast on failure, so nothing typed is lost.
export function openPlaceSheet({ mode = 'add', onConfirm } = {}) {
  const suggest = mode === 'suggest';
  let chosen = null;
  let busy = false;

  const input = el('input', {
    type: 'text',
    placeholder: t('saved.searchPlaceholder'),
    class:
      'w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
    'aria-label': t('saved.searchPlaceholder'),
    dataset: { savedPlaceSearch: 'true' },
  });

  const resultsBox = el('div', { class: 'flex flex-col gap-2', dataset: { savedPlaceResults: 'true' } });
  const pickedBox = el('div', { class: 'flex flex-col gap-2', dataset: { savedPlacePicked: 'true' } });

  let searchAbort = null;
  let debounceTimer = 0;
  let queryToken = 0;

  function clearSearch() {
    if (debounceTimer) window.clearTimeout(debounceTimer);
    if (searchAbort) searchAbort.abort();
    searchAbort = null;
    queryToken += 1;
  }

  function renderResults(places) {
    resultsBox.replaceChildren(
      ...(places || []).map((place) =>
        resultRow(place, { onPick: (p) => pick(p) })),
    );
  }

  function setResultsMessage(text, { loading = false } = {}) {
    resultsBox.replaceChildren(
      loading
        ? el('div', { class: 'flex items-center gap-2 px-1 py-2' }, [spinner(), el('p', { class: 'text-sm text-muted', text })])
        : el('p', { class: 'px-1 py-2 text-sm text-muted', text }),
    );
  }

  async function runSearch(q) {
    const token = ++queryToken;
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    setResultsMessage(t('saved.searchSearching'), { loading: true });
    try {
      const raw = await fetchSearch(q, { signal: searchAbort.signal });
      if (token !== queryToken) return; // a newer query superseded this one
      const places = (raw || [])
        .map((result) => placeFromSearchResult(result))
        .filter((place) => place && hasCoords(place));
      if (!places.length) setResultsMessage(t('saved.searchNoMatches'));
      else renderResults(places);
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return;
      if (token !== queryToken) return;
      setResultsMessage(t('saved.searchFailed'));
    }
  }

  function onQueryInput() {
    const q = input.value.trim();
    if (q.length < MIN_QUERY) {
      clearSearch();
      setResultsMessage(q ? t('saved.searchTooShort') : t('saved.searchHint'));
      return;
    }
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => runSearch(q), DEBOUNCE_MS);
  }

  function pick(place) {
    chosen = place;
    clearSearch();
    pickedBox.replaceChildren(
      el('div', { class: 'flex flex-col gap-2' }, [
        el('div', { class: 'rounded-card border border-line bg-surface-raised px-3 py-2.5' }, [
          el('p', { class: 'text-sm font-semibold text-ink', text: place.name }),
          (categoryLabel(place) || place.address)
            ? el('p', { class: 'text-xs text-muted', text: categoryLabel(place) || place.address })
            : null,
        ]),
        suggest
          ? el('textarea', {
              rows: '3',
              maxlength: '200',
              placeholder: t('saved.suggestMessagePlaceholder'),
              class:
                'w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              'aria-label': t('saved.suggestMessageLabel'),
              dataset: { savedSuggestMessage: 'true' },
            })
          : null,
        el('div', { class: 'flex gap-2' }, [
          confirmBtn,
          el('div', {}, [backBtn]),
        ]),
      ]),
    );
    resultsBox.replaceChildren();
  }

  function backToSearch() {
    chosen = null;
    pickedBox.replaceChildren();
    onQueryInput(); // restore the results list for the current term
  }

  const confirmBtn = button(
    suggest ? t('saved.suggestSend') : t('saved.addConfirm'),
    { variant: 'primary' },
  );
  const backBtn = button(t('common.back'), { variant: 'secondary', onClick: backToSearch });

  confirmBtn.addEventListener('click', async () => {
    if (!chosen || busy) return;
    busy = true;
    confirmBtn.disabled = true;
    const messageNode = pickedBox.querySelector('[data-saved-suggest-message]');
    const message = suggest && messageNode ? messageNode.value.trim() || null : null;
    try {
      await onConfirm(chosen, message);
      close();
    } catch (err) {
      toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
      busy = false;
      confirmBtn.disabled = false;
    }
  });

  input.addEventListener('input', onQueryInput);

  const form = el('form', {
    class: 'flex flex-col gap-3',
    dataset: { savedPlaceSheet: 'true' },
    onSubmit: (event) => event.preventDefault(),
  }, [
    el('h2', {
      class: 'text-lg font-semibold text-ink',
      text: suggest ? t('saved.searchSheetSuggest') : t('saved.searchSheetAdd'),
    }),
    input,
    resultsBox,
    pickedBox,
  ]);

  setResultsMessage(t('saved.searchHint'));

  const surface = present(form, {
    label: suggest ? t('saved.searchSheetSuggest') : t('saved.searchSheetAdd'),
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearSearch();
    surface.dismiss();
  }

  // Escape/entry focus: put the cursor in the field so typing starts at once.
  const focusInput = form.querySelector('[data-saved-place-search]');
  if (focusInput) focusInput.focus({ preventScroll: true });

  return { dismiss: close };
}