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
  pin: '<path d="M20 10c0 6-8 11-8 11s-8-5-8-11a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  swap:
    '<path d="M7 4v13"/><path d="m3 13 4 4 4-4"/><path d="M17 20V7"/><path d="m13 11 4-4 4 4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  'arrow-up': '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 1.5"/>',
  star: '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9Z"/>',
  phone:
    '<path d="M5 3h4l1.5 4.5L8 9a12 12 0 0 0 7 7l1.5-2.5L21 15v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18Z"/>',
  photo:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-4-4-7 7"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  // Turn-by-turn maneuver icons (Phase 8). Same 24-grid stroke artwork;
  // direction-agnostic shapes for merge/ramp/fork/roundabout — the side is
  // carried by the instruction text.
  straight: '<path d="M12 20V4"/><path d="m6 10 6-6 6 6"/>',
  'turn-left': '<path d="M19 20V8a2 2 0 0 0-2-2H5"/><path d="m9 2-4 4 4 4"/>',
  'turn-right': '<path d="M5 20V8a2 2 0 0 1 2-2h12"/><path d="m15 2 4 4-4 4"/>',
  'slight-left': '<path d="M17 20 8 11"/><path d="M8 17v-6h6"/>',
  'slight-right': '<path d="m7 20 9-9"/><path d="M16 17v-6h-6"/>',
  'sharp-left': '<path d="M17 20v-7a3 3 0 0 0-3-3H6"/><path d="m10 6-4 4 4 4"/>',
  'sharp-right': '<path d="M7 20v-7a3 3 0 0 1 3-3h8"/><path d="m14 6 4 4-4 4"/>',
  uturn: '<path d="M17 20V8a4 4 0 0 0-8 0v12"/><path d="m5 16 4 4 4-4"/>',
  roundabout:
    '<circle cx="11" cy="9" r="3.5"/><path d="M11 21v-5"/><path d="M14.5 9H21"/><path d="m18 6 3 3-3 3"/>',
  merge: '<path d="M8 7 12 3l4 4"/><path d="M12 3v18"/>',
  fork: '<path d="M12 21v-5"/><path d="m12 16-5-7"/><path d="m12 16 5-7"/>',
  ramp: '<path d="M4 21C11 21 18 16 18 7"/><path d="m14 4 4 3-4 3"/>',
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
