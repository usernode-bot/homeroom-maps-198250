// Directions — placeholder. Route planning and navigation are not built; this
// screen is an honest empty state only.
import { el } from '../components/dom.js';
import { emptyState } from '../components/empty-state.js';
import { placeholderPanel } from '../components/placeholder-panel.js';
import { t } from '../i18n/index.js';

export async function render(ctx) {
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.directions') }),
    emptyState({
      title: t('directions.emptyTitle'),
      description: t('directions.emptyBody'),
    }),
    placeholderPanel({
      title: t('directions.panelTitle'),
      description: t('directions.panelBody'),
    }),
  );
}
