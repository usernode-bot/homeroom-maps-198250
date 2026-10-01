// Bottom navigation — the five main areas of Homeroom Maps. The one primary
// action across the app, present at every width (phone through desktop).
// Tab switches are high-frequency, so they are instant: no transition.
import { el } from './dom.js';
import { icon } from './icons.js';
import * as router from '../router.js';

const TABS = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'discover', label: 'Discover', icon: 'discover' },
  { name: 'directions', label: 'Directions', icon: 'directions' },
  { name: 'community', label: 'Community', icon: 'community' },
  { name: 'profile', label: 'Profile', icon: 'profile' },
];

export function bottomNav(activeName) {
  const items = TABS.map((tab) => {
    const active = tab.name === activeName;
    const node = el(
      'button',
      {
        type: 'button',
        class: [
          'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          active ? 'text-brand' : 'text-muted hover:text-ink',
        ].join(' '),
        dataset: { tab: tab.name },
        // Only the current tab is marked current for assistive tech.
        ...(active ? { 'aria-current': 'page' } : {}),
      },
      [icon(tab.icon, { class: 'h-5 w-5' }), el('span', { class: 'truncate', text: tab.label })],
    );
    node.addEventListener('click', () => router.navigate(tab.name));
    return node;
  });

  return el(
    'nav',
    {
      class:
        'un-safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/80 backdrop-blur',
      'aria-label': 'Main',
    },
    [
      el(
        'div',
        { class: 'mx-auto flex max-w-3xl items-stretch gap-1 px-2 py-1' },
        items,
      ),
    ],
  );
}

export { TABS };
