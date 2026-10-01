// Inline stroke icons on a 24-unit grid, drawn to match the native UI kit's
// Lucide-style artwork (2px round strokes in currentColor). One small set,
// kept here so screens never reach for an emoji or a new library.

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
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  pin: '<path d="M20 10c0 5-8 12-8 12s-8-7-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="7"/>',
};

export function icon(name, { class: extra = 'h-5 w-5' } = {}) {
  // Created in the SVG namespace: document.createElement('svg') would make an
  // unknown HTML element that never draws.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = {
    class: extra,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  svg.innerHTML = PATHS[name] || '';
  return svg;
}
