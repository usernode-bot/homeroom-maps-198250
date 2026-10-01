// Loading state — a skeleton block plus a small spinner. Shown while a
// screen's data is being fetched, so the layout holds instead of flashing
// blank. `data-loading` is the hook the shell and checks use.
import { el } from './dom.js';
import { t } from '../i18n/index.js';

export function spinner() {
  return el('div', {
    class:
      'h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand',
    role: 'status',
    'aria-label': t('common.loading'),
  });
}

export function loading({ label = t('common.loading') } = {}) {
  return el(
    'div',
    { class: 'flex flex-col items-center gap-3 py-10', dataset: { loading: 'true' } },
    [
      spinner(),
      el('p', { class: 'text-sm text-muted', text: label }),
      el('div', { class: 'w-full max-w-sm space-y-3' }, [
        el('div', { class: 'h-4 w-full animate-pulse rounded bg-surface-raised' }),
        el('div', { class: 'h-4 w-5/6 animate-pulse rounded bg-surface-raised' }),
        el('div', { class: 'h-4 w-2/3 animate-pulse rounded bg-surface-raised' }),
      ]),
    ],
  );
}
