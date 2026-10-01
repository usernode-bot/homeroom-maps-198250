// Map-control icons, in the same Lucide-style stroke artwork as the shared
// icon set (2px round strokes on a 24 grid in currentColor). Kept in the map
// module rather than the shared component, so the map feature adds its own
// glyphs without touching the app's common components.
import { el } from '../components/dom.js';

const PATHS = {
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="m9.5 9.5 2.5-2.5 2.5 2.5"/>',
  locate:
    '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
};

export function mapIcon(name, { class: extra = 'h-5 w-5' } = {}) {
  return el('svg', {
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
}
