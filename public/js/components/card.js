// Card — the rounded, bordered surface the whole app uses. Only wrap
// something in a card when the card itself is what you tap; plain layout uses
// spacing and dividers instead.
import { el } from './dom.js';

export function card(children, { class: extra = '', attrs = {} } = {}) {
  return el(
    'div',
    {
      class: `rounded-card border border-line bg-surface p-4 ${extra}`.trim(),
      ...attrs,
    },
    children,
  );
}
