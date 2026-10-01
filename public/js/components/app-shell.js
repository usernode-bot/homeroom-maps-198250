// App shell — top bar, content region and bottom navigation. Screens render
// only their own body into the content region, so every screen shares the
// same chrome, spacing and safe-area handling.
import { el } from './dom.js';
import { topBar } from './top-bar.js';
import { bottomNav } from './bottom-nav.js';

export function renderShell(root, { activeName, subtitle = '' } = {}) {
  root.replaceChildren(
    topBar({ subtitle }),
    el(
      'main',
      {
        class:
          'mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pb-28 pt-20',
      },
      [el('div', { class: 'contents', dataset: { screenHost: 'true' } })],
    ),
    bottomNav(activeName),
  );
  return root.querySelector('[data-screen-host]');
}
