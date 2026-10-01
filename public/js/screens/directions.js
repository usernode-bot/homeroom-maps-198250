// Directions — placeholder. Route planning and navigation are not built; this
// screen is an honest empty state only.
import { el } from '../components/dom.js';
import { emptyState } from '../components/empty-state.js';
import { placeholderPanel } from '../components/placeholder-panel.js';

export async function render(ctx) {
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: 'Directions' }),
    emptyState({
      title: 'No directions yet',
      description: 'Route planning and navigation will appear here.',
    }),
    placeholderPanel({
      title: 'Route planning',
      description: 'Turn-by-turn navigation is coming soon.',
    }),
  );
}
