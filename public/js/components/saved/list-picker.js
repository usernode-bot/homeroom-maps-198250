// List picker — the sheet Discover's Save button opens. Shows the person's
// own lists (real ones, fetched fresh each time so a list created in this
// same flow appears) with their emoji badge and item count, plus a New list
// entry that hands control back to the caller, which opens the list form and
// usually saves the place into the freshly created list.
import { el } from '../dom.js';
import { button } from '../button.js';
import { emptyState } from '../empty-state.js';
import { loading } from '../loading.js';
import { present } from '../surface.js';
import { emojiBadge, visibilityPill } from './parts.js';
import { fetchMyLists } from '../../services/saved.js';
import { t } from '../../i18n/index.js';

export function openListPicker({ onPick, onCreateNew } = {}) {
  const body = el('div', {
    class: 'flex flex-col gap-2',
    dataset: { savedListPicker: 'true' },
  });
  const sheet = el('div', { class: 'flex flex-col gap-3' }, [
    el('h2', { class: 'text-lg font-semibold text-ink', text: t('saved.saveTo') }),
    body,
  ]);
  const surface = present(sheet, { label: t('saved.saveTo') });

  function dismiss() {
    surface.dismiss();
  }

  async function load() {
    body.replaceChildren(loading({ label: t('saved.loadingLists') }));
    let lists;
    try {
      lists = await fetchMyLists();
    } catch {
      body.replaceChildren(
        el('p', { class: 'px-1 text-sm text-danger', text: t('saved.loadListsFailed') }),
      );
      return;
    }
    if (!lists.length) {
      body.replaceChildren(
        emptyState({
          title: t('saved.emptyMineTitle'),
          description: t('saved.emptyMineBody'),
          action: button(t('saved.newList'), {
            variant: 'primary',
            onClick: () => {
              dismiss();
              if (onCreateNew) onCreateNew();
            },
          }),
        }),
      );
      return;
    }
    body.replaceChildren(
      el('div', { class: 'flex flex-col divide-y divide-line' },
        lists.map((list) =>
          el('button', {
            type: 'button',
            class:
              'flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            dataset: { savedPickList: list.id },
            onClick: () => {
              dismiss();
              if (onPick) onPick(list);
            },
          }, [
            emojiBadge(list.emoji, { class: 'h-9 w-9 text-lg' }),
            el('span', { class: 'min-w-0 flex-1' }, [
              el('span', { class: 'block truncate text-sm font-medium text-ink', text: list.name }),
              el('span', {
                class: 'block truncate text-xs text-muted',
                text: t('saved.placeCount').replace('{count}', String(list.itemCount)),
              }),
            ]),
            visibilityPill(list.visibility),
          ])),
      ),
      el('div', { class: 'pt-2' }, [
        button(t('saved.newList'), {
          variant: 'secondary',
          onClick: () => {
            dismiss();
            if (onCreateNew) onCreateNew();
          },
        }),
      ]),
    );
  }

  load();
  return { dismiss };
}