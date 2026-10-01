// Top bar — the app name and, when known, who is signed in. Fixed, blurred
// and translucent like the starter screen's surfaces; safe-area aware so it
// clears the status bar inside the platform frame.
import { el } from './dom.js';

export function topBar({ title = 'Homeroom Maps', subtitle = '' } = {}) {
  return el(
    'header',
    {
      class:
        'un-safe-top fixed inset-x-0 top-0 z-30 border-b border-line bg-surface/70 backdrop-blur',
    },
    [
      el(
        'div',
        {
          class:
            'mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4',
        },
        [
          el('span', { class: 'text-base font-semibold tracking-tight text-ink', text: title }),
          el('span', {
            class: 'truncate text-sm text-muted',
            text: subtitle || '',
            dataset: { username: 'true' },
          }),
        ],
      ),
    ],
  );
}
