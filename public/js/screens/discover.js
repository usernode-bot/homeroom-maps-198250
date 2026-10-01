// Discover — placeholder. Places and points of interest arrive with the map in
// a later stage; this screen states that plainly rather than pretending.
import { el } from '../components/dom.js';
import { emptyState } from '../components/empty-state.js';
import { placeholderPanel } from '../components/placeholder-panel.js';

export async function render(ctx) {
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: 'Discover' }),
    emptyState({
      title: 'Nothing to discover yet',
      description: 'Places and points of interest will appear here.',
    }),
    placeholderPanel({
      title: 'Places and points of interest',
      description: 'Browsing, search and categories are coming soon.',
    }),
  );
}
