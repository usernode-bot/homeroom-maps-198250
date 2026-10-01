// Map-control icons, in the same Lucide-style stroke artwork as the shared
// icon set (2px round strokes on a 24 grid in currentColor). Kept in the map
// module rather than the shared component, so the map feature adds its own
// glyphs without touching the app's common components.
//
// These glyphs must be created with `createElementNS` in the SVG namespace.
// `document.createElement('svg')` yields an HTMLUnknownElement: the browser
// then parses the path markup as unknown HTML (the paths nest instead of being
// siblings), the SVG geometry API is missing, and nothing is painted. An empty
// control button is exactly what "dark circle, no visible icon" looks like, so
// the namespace has to be explicit here even though `el()` is used elsewhere.
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="m9.5 9.5 2.5-2.5 2.5 2.5"/>',
  locate:
    '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
};

export function mapIcon(name, { class: extra = 'h-5 w-5' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', extra);
  svg.setAttribute('viewBox', '0 0 24 24');
  // `none` here and `currentColor` on the stroke: the glyph paints in the
  // button's own text colour (text-ink), so it follows the app's light/dark
  // tokens with no icon-specific colour rule, and the disabled Map layers
  // placeholder keeps the dimmed look its opacity already gives it.
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // The markup is trusted, hand-written path data from PATHS above. Parsed
  // against the SVG namespace it becomes real <path>/<circle> siblings.
  svg.innerHTML = PATHS[name] || '';
  return svg;
}
