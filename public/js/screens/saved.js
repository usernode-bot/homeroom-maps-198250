// Saved — the person's saved places, and the lists they keep them in.
//
// Two levels, both hash routes so reload, back and share keep working:
//
//   #/saved              the lists (four defaults plus custom ones) and every
//                        saved place, newest first
//   #/saved?list=<id>    one list and its real contents
//
// Every count and every row comes from the server (saved/routes.js). A place
// is only ever shown if it was really saved, and only the signed-in person's
// rows are ever requested: the API scopes each query to the token's user.
// Deleting a list removes the list, never the places in it.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { icon } from '../components/icons.js';
import { loading } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { createPlaceCard } from '../components/place/place-card.js';
import { openListPicker } from '../components/saved/list-picker.js';
import { promptText, confirmAction } from '../components/saved/dialogs.js';
import { hasToken } from '../auth.js';
import { t } from '../i18n/index.js';
import * as router from '../router.js';
import {
  fetchLists,
  fetchPlaces,
  fetchList,
  createList,
  renameList,
  deleteList,
  removeFromList,
  savedToPlace,
} from '../services/saved-places.js';

function toast(message, { error = false } = {}) {
  const kit = window.unNative;
  if (kit && typeof kit.toast === 'function') {
    try {
      kit.toast(message, error ? { priority: true } : {});
      return;
    } catch {
      /* fall through */
    }
  }
  console.info('[saved] ' + message);
}

export async function render(ctx) {
  const listId = router.hashParams().get('list');

  // The heading, the intro and the host are the same for every state, so the
  // screen has one stable root whether or not there is an identity to load.
  const host = el('div', { class: 'flex flex-col gap-3', dataset: { savedHost: 'true' } });
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('saved.title') }),
    el('p', { class: 'text-sm text-muted leading-relaxed', text: t('saved.intro') }),
    host,
  );

  // Opened outside Homeroom (or offline): there is nobody to save as, and the
  // API would rightly refuse. Say so instead of asking for a list.
  if (!hasToken()) {
    host.dataset.savedState = 'signed_out';
    host.replaceChildren(
      emptyState({ title: t('saved.signedOutTitle'), description: t('saved.signedOutBody') }),
    );
    return;
  }

  host.replaceChildren(loading({ label: t('saved.loading') }));

  try {
    if (listId) await renderList(listId);
    else await renderLists();
  } catch (err) {
    host.dataset.savedState = 'error';
    host.replaceChildren(
      errorState({
        title: t('saved.loadError'),
        description: (err && err.message) || t('common.tryAgain'),
        onRetry: () => render(ctx),
      }),
    );
  }

  // ---- the lists overview, with every saved place ----

  async function renderLists() {
    const [lists, places] = await Promise.all([fetchLists(), fetchPlaces()]);
    host.dataset.savedState = places.length ? 'ready' : 'empty';
    host.replaceChildren(
      el('div', { class: 'flex items-center justify-between gap-3' }, [
        el('h2', { class: 'text-base font-semibold text-ink', text: t('saved.listsTitle') }),
        button(t('saved.newList'), { variant: 'secondary', onClick: newList, attrs: { 'data-new-list': 'true' } }),
      ]),
      el(
        'div',
        { class: 'divide-y divide-line rounded-card border border-line bg-surface' },
        lists.map(listRow),
      ),
      el('p', { class: 'text-xs text-muted leading-relaxed', text: t('saved.customHint') }),
      el('h2', { class: 'mt-2 text-base font-semibold text-ink', text: t('saved.placesTitle') }),
      places.length
        ? el(
            'div',
            { class: 'flex flex-col gap-3', dataset: { savedPlaces: 'true' } },
            places.map((saved) => placeBlock(saved, null)),
          )
        : emptyState({ title: t('saved.emptyTitle'), description: t('saved.emptyBody') }),
    );
  }

  function listRow(list) {
    const count =
      list.itemCount === 1 ? t('saved.itemOne') : t('saved.items', { count: list.itemCount });
    return el(
      'button',
      {
        type: 'button',
        class:
          'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        dataset: { savedList: String(list.id), listKind: list.kind },
        onClick: () => go({ list: list.id }),
      },
      [
        icon('list', { class: 'h-5 w-5 shrink-0 text-muted' }),
        el('span', { class: 'min-w-0 flex-1' }, [
          el('span', { class: 'block truncate text-sm font-medium text-ink', text: list.name }),
          el('span', { class: 'block text-xs text-muted', text: count }),
        ]),
        icon('arrow-up', { class: 'h-4 w-4 shrink-0 rotate-90 text-muted' }),
      ],
    );
  }

  // ---- one list and its contents ----

  async function renderList(id) {
    const list = await fetchList(id);
    host.dataset.savedState = list.items.length ? 'ready' : 'empty';
    host.replaceChildren(
      el('div', { class: 'flex flex-col gap-2' }, [
        el('button', {
          type: 'button',
          class:
            'self-start rounded-pill border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          text: t('saved.backToLists'),
          dataset: { savedBack: 'true' },
          onClick: () => go({}),
        }),
        el('div', { class: 'flex items-start justify-between gap-2' }, [
          el('div', { class: 'min-w-0' }, [
            el('h2', { class: 'truncate text-base font-semibold text-ink', text: list.name }),
            el('p', {
              class: 'text-xs text-muted',
              text: list.kind === 'default' ? t('saved.defaultListNote') : t('saved.customListNote'),
            }),
          ]),
          list.kind === 'custom'
            ? el('div', { class: 'flex shrink-0 gap-2' }, [
                button(t('saved.rename'), {
                  variant: 'secondary',
                  attrs: { 'data-list-rename': 'true' },
                  onClick: () => rename(list),
                }),
                button(t('saved.delete'), {
                  variant: 'secondary',
                  class: 'text-danger',
                  attrs: { 'data-list-delete': 'true' },
                  onClick: () => remove(list),
                }),
              ])
            : null,
        ]),
      ]),
      list.items.length
        ? el(
            'div',
            { class: 'flex flex-col gap-3', dataset: { savedListItems: 'true' } },
            list.items.map((saved) => placeBlock(saved, list)),
          )
        : emptyState({ title: t('saved.listEmptyTitle'), description: t('saved.listEmptyBody') }),
    );
  }

  // ---- one saved place: the reusable Place Card plus this screen's actions ----

  function placeBlock(saved, list) {
    const place = savedToPlace(saved);
    const openList =
      list || (Array.isArray(saved.listIds) && saved.listIds[0] ? { id: saved.listIds[0] } : null);
    const cardEl = createPlaceCard(
      place,
      openList ? { onSelect: () => go({ list: openList.id }) } : {},
    );
    const actions = el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      button(t('saved.addToList'), {
        variant: 'secondary',
        onClick: () => openListPicker({ place, onChanged: refresh }),
      }),
      list
        ? button(t('saved.removeFromList'), {
            variant: 'ghost',
            onClick: () => removeItem(list, place),
          })
        : null,
    ]);
    return el('div', { class: 'flex flex-col gap-1.5', dataset: { savedPlace: place.id } }, [cardEl, actions]);
  }

  // ---- actions ----

  async function refresh() {
    try {
      if (listId) await renderList(listId);
      else await renderLists();
    } catch (err) {
      toast((err && err.message) || t('saved.loadError'), { error: true });
    }
  }

  // Move between the two levels of this screen without a full navigation: the
  // hash query is rewritten in place and the screen re-renders from it.
  function go(params) {
    router.replaceHashParams(params);
    render(ctx);
  }

  async function newList() {
    const name = await promptText({
      title: t('saved.newList'),
      label: t('saved.listName'),
      placeholder: t('saved.newListPlaceholder'),
      confirmLabel: t('saved.create'),
    });
    if (!name) return;
    try {
      const created = await createList(name);
      toast(t('saved.listCreated', { name: created.name }));
      go({ list: created.id });
    } catch (err) {
      toast(
        (err && err.fields && err.fields.name) || (err && err.message) || t('saved.updateError'),
        { error: true },
      );
    }
  }

  async function rename(list) {
    const name = await promptText({
      title: t('saved.rename'),
      label: t('saved.listName'),
      value: list.name,
      confirmLabel: t('saved.saveChanges'),
    });
    if (!name || name === list.name) return;
    try {
      await renameList(list.id, name);
      toast(t('saved.listRenamed'));
      await refresh();
    } catch (err) {
      toast(
        (err && err.fields && err.fields.name) || (err && err.message) || t('saved.updateError'),
        { error: true },
      );
    }
  }

  async function remove(list) {
    const ok = await confirmAction({
      title: t('saved.deleteConfirmTitle', { name: list.name }),
      message: t('saved.deleteConfirmBody'),
      confirmLabel: t('saved.delete'),
    });
    if (!ok) return;
    try {
      await deleteList(list.id);
      toast(t('saved.listDeleted'));
      go({});
    } catch (err) {
      toast((err && err.message) || t('saved.updateError'), { error: true });
    }
  }

  async function removeItem(list, place) {
    try {
      await removeFromList(list.id, place.id);
      toast(t('saved.removedFromList'));
      await refresh();
    } catch (err) {
      toast((err && err.message) || t('saved.updateError'), { error: true });
    }
  }
}
