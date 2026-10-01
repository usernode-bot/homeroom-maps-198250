// Empty state — the honest "nothing here yet" surface, with an optional one
// primary action. Every data view in the app uses this rather than a blank
// area.
import { el } from './dom.js';

export function emptyState({ title, description, action } = {}) {
  return el('div', { class: 'flex flex-col items-center gap-2 py-6 text-center' }, [
    title ? el('p', { class: 'text-base font-semibold text-ink', text: title }) : null,
    description
      ? el('p', { class: 'max-w-sm text-sm text-muted leading-relaxed', text: description })
      : null,
    action || null,
  ]);
}
