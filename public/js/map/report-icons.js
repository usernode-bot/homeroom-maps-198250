// Report type glyphs (Phase 6) — the Community report types as small inline
// SVG, in the same 24×24, 2px-round-stroke language as map/icons.js, plus
// the rasterized pin images the map renderer draws.
//
// Lucide icons (ISC licence), like the rest of the app's map glyphs. The
// DOM uses the SVG markup directly (the browser renders every curve and
// arc); the map rasterizes the whole pin through the same engine, so a
// glyph never reads differently in the form and on the map. Expired
// reports keep their type glyph but render in the muted grey the feed uses.

const STROKE_COLOR = '#ffffff';
const PIN_COLOR = '#4f46e5';
const PIN_COLOR_EXPIRED = '#9ca3af';
const PIN_SIZE = 36;

const TYPES = {
  traffic: {
    svg: '<circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="8.5" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/><path d="M6.5 15.5h11"/>',
  },
  accident: {
    svg: '<path d="M14 8l4 8M10 8L6 16"/><path d="M8 16h8"/><path d="M4 20h16"/><path d="M13 4l1 2M17 6l-1.5 1.5"/>',
  },
  road_closed: {
    svg: '<path d="M6 21V3M18 21V3"/><rect x="10" y="3" width="4" height="5" rx="1"/><rect x="10" y="9.5" width="4" height="5" rx="1"/><rect x="10" y="16" width="4" height="5" rx="1"/>',
  },
  construction: {
    svg: '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-5h6v5"/><path d="M12 5v3"/>',
  },
  hazard: {
    svg: '<path d="M12 3L2 20h20L12 3z"/><path d="M12 9v5"/><path d="M12 17.5v.01"/>',
  },
  flood: {
    svg: '<path d="M3 17c1.5 1.5 3 1.5 4.5 0s3-1.5 4.5 0 3-1.5 4.5 0 3-1.5 4.5 0"/><path d="M3 21c1.5 1.5 3 1.5 4.5 0s3-1.5 4.5 0 3 1.5 4.5 0 3-1.5 4.5 0"/><path d="M8 12a4 4 0 0 1 8 0"/>',
  },
  fire: {
    svg: '<path d="M12 3c1 3-2 4.5-2 7a2 2 0 0 0 4 0c0-1 .5-2 1.5-2.5C16 9.5 17 11 17 13a5 5 0 0 1-10 0c0-4 3.5-6 5-10z"/><path d="M12 21a3 3 0 0 0 3-3c0-1.5-1-2.5-3-4-2 1.5-3 2.5-3 4a3 3 0 0 0 3 3z"/>',
  },
  broken_road: {
    svg: '<path d="M7 21V3M17 21V3"/><path d="M12 4v3M12 11v3M12 18v2"/>',
  },
  wrong_map_data: {
    svg: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  },
  place_closed: {
    svg: '<path d="M5 21V8l7-5 7 5v13"/><path d="M9.5 12l5 5M14.5 12l-5 5"/>',
  },
  other: {
    svg: '<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M12 12v4"/>',
  },
};

export const REPORT_TYPES = Object.keys(TYPES);

// Inline SVG for the DOM (the report form's picker, the detail header and
// the feed rows). `currentColor` on the stroke lets the caller's own text
// colour drive it, the same contract map/icons.js gives its glyphs. `cls`
// is applied to the <svg> element so callers size it from their CSS.
export function reportIconMarkup(type, cls) {
  const def = TYPES[type] || TYPES.other;
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
    (cls ? ` class="${cls}"` : '') +
    '>' +
    def.svg +
    '</svg>'
  );
}

// The whole pin as a standalone SVG document: the round body in the report
// accent (muted grey when expired) with the white glyph centred inside it,
// plus a hairline ring that keeps the pin legible over route lines.
function pinSvg(type, expired) {
  const def = TYPES[type] || TYPES.other;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="11.5" fill="${expired ? PIN_COLOR_EXPIRED : PIN_COLOR}" ` +
    'stroke="rgba(255, 255, 255, 0.55)" stroke-width="0.75"/>' +
    '<g transform="translate(12 12) scale(0.625) translate(-12 -12)" fill="none" ' +
    `stroke="${STROKE_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    def.svg +
    '</g></svg>'
  );
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('report pin failed to rasterize'));
    image.src = url;
  });
}

// Rasterize one pin at `pixelRatio` × its 36 px layout size and return a
// canvas, which maplibre accepts directly as a sprite image. The browser's
// SVG engine does the drawing, so every curve and arc in the glyph markup
// renders exactly as it does in the DOM.
export async function reportPinImage(type, { expired = false, pixelRatio = 1 } = {}) {
  const blob = new Blob([pinSvg(type, expired)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const size = Math.round(PIN_SIZE * pixelRatio);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(image, 0, 0, size, size);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}