// List picker — the sheet that files a place into the person's lists.
//
// It loads the REAL lists (the four seeded defaults plus their custom ones)
// and the REAL memberships; each row toggles one membership through the API
// and re-renders from what the server answered. Nothing is shown checked
// until the server has confirmed it.
//
// The place is saved on the way: adding a place to a list saves it first, so
// "add to a list" always means "saved, and in this list". Removing the last
// membership does NOT unsave the place — unsaving is the Save button's job,
// and this sheet says so.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { errorState } from '../error-state.js';
import { present } from '../surface.js';
import { t } from '../../i18n/index.js';
import {
  fetchList,
  fetchLists,
  addToList,
  removeFromList,
  createList,
  listsContaining,
  savedPlaces,
} from '../../services/saved-places.js';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

// opts: { place, onChanged() } — onChanged fires after any membership change
// so the caller can refresh a count or a saved state.
export function openListPicker({ place, onChanged } = {}) {
  const body = el('div', { class: 'flex flex-col gap-3', dataset: { listPicker: 'true' } });
  let surface = null;
  let lists = [];
  let membership = new Set();
  let busyListId = null;
  let phase = 'loading';
  let loadError = null;

  function close() {
    if (surface) surface.dismiss();
  }

  function report(err) {
    if (window.unNative && window.unNative.toast) {
      window.unNative.toast((err && err.message) || t('saved.updateError'), { priority: true });
    }
  }

  async function load() {
    phase = 'loading';
    render();
    try {
      const [fetchedLists, inLists] = await Promise.all([
        fetchLists(),
        listsContaining(place.id).catch(() => new Set()),
      ]);
      lists = fetchedLists;
      membership = inLists;
      phase = 'ready';
    } catch (err) {
      loadError = err;
      phase = 'error';
    }
    render();
  }

  async function toggle(list) {
    if (busyListId) return;
    busyListId = String(list.id);
    render();
    const isIn = membership.has(String(list.id));
    try {
      if (isIn) await removeFromList(list.id, place.id);
      else await addToList(list.id, place);
      // Re-read the list and take the membership from its real contents, so
      // the checkbox can never disagree with what the server stored.
      const detail = await fetchList(list.id);
      const items = Array.isArray(detail.items) ? detail.items : [];
      const stillIn = items.some((item) => item.id === place.id);
      if (stillIn) membership.add(String(list.id));
      else membership.delete(String(list.id));
      lists = lists.map((l) => (l.id === list.id ? { ...l, itemCount: items.length } : l));
      busyListId = null;
      render();
      if (onChanged) onChanged();
    } catch (err) {
      busyListId = null;
      render();
      report(err);
    }
  }

  async function createAndAdd(name) {
    try {
      const created = await createList(name);
      await addToList(created.id, place);
      membership.add(String(created.id));
      lists = [...lists, { ...created, itemCount: 1 }];
      render();
      if (onChanged) onChanged();
    } catch (err) {
      report(err);
    }
  }

  function row(list) {
    const inList = membership.has(String(list.id));
    const busy = busyListId === String(list.id);
    return el(
      'button',
      {
        type: 'button',
        class:
          'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        'aria-pressed': inList ? 'true' : 'false',
        disabled: Boolean(busyListId),
        dataset: { listOption: String(list.id), listSlug: list.systemKey || '' },
        onClick: () => toggle(list),
      },
      [
        el('span', {
          class: [
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
            inList ? 'border-brand bg-brand text-brand-contrast' : 'border-line bg-surface',
          ].join(' '),
          'aria-hidden': 'true',
        }, [inList ? icon('check', { class: 'h-4 w-4' }) : null]),
        el('span', { class: 'min-w-0 flex-1' }, [
          el('span', { class: 'block truncate text-sm font-medium text-ink', text: list.name }),
          el('span', {
            class: 'block text-xs text-muted',
            text: list.itemCount === 1 ? t('saved.itemOne') : t('saved.items', { count: list.itemCount }),
          }),
        ]),
        busy ? spinner() : null,
      ],
    );
  }

  function render() {
    if (phase === 'loading') {
      body.replaceChildren(
        el('div', { class: 'flex items-center gap-3 py-6', role: 'status' }, [
          spinner(),
          el('p', { class: 'text-sm text-muted', text: t('saved.loadingLists') }),
        ]),
      );
      return;
    }
    if (phase === 'error') {
      body.replaceChildren(
        errorState({
          title: t('saved.listsError'),
          description: (loadError && loadError.message) || t('common.tryAgain'),
          onRetry: load,
        }),
      );
      return;
    }
    const nameInput = el('input', {
      type: 'text',
      class: INPUT,
      maxlength: '60',
      placeholder: t('saved.newListPlaceholder'),
      dataset: { newListName: 'true' },
    });
    const addForm = el('div', { class: 'flex gap-2' }, [
      nameInput,
      button(t('saved.newList'), {
        variant: 'secondary',
        onClick: () => {
          const name = nameInput.value.trim();
          if (name) createAndAdd(name);
        },
      }),
    ]);
    body.replaceChildren(
      el('div', { class: 'divide-y divide-line rounded-lg border border-line' }, lists.map(row)),
      el('p', { class: 'text-xs text-muted leading-relaxed', text: t('saved.pickerHint') }),
      addForm,
    );
  }

  render();
  surface = present(body, { label: t('saved.addToLists'), onDismiss: () => {} });
  load();
  return { dismiss: close };
}
