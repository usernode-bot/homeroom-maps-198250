// Inline stroke icons on a 24-unit grid, drawn to match the native UI kit's
// Lucide-style artwork (2px round strokes in currentColor). One small set,
// kept here so screens never reach for an emoji or a new library.
import { el } from './dom.js';

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  discover:
    '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  directions:
    '<path d="m21 3-9 18-2-7-7-2Z"/>',
  community:
    '<path d="M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19"/><circle cx="9.5" cy="7" r="3.5"/><path d="M21 19v-1.5a4 4 0 0 0-3-3.85"/><path d="M15.5 3.65a4 4 0 0 1 0 7.7"/>',
  profile:
    '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
};

export function icon(name, { class: extra = 'h-5 w-5' } = {}) {
  const svg = el('svg', {
    class: extra,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    html: PATHS[name] || '',
  });
  return svg;
}
