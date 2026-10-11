// The map overlay controls, rendered into Home's existing top-right
// `data-map-controls` slot. Zoom in, zoom out, reset north, My location and
// Weather and Traffic are real buttons; Map layers stays the disabled "Coming soon"
// placeholder.
//
// Which controls appear is driven by the adapter's capability flags: a device
// whose renderer cannot rotate simply has no reset-north button, rather than a
// control that does nothing. The Traffic control is the exception by design:
// it shows whenever the map itself is live and opens the honest traffic panel
// (Phase 12D) — live traffic is not connected, and the control never pretends
// otherwise by turning anything on.
import { el } from '../components/dom.js';
import { mapIcon } from './icons.js';
import { t } from '../i18n/index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The Traffic control's glyph, built here rather than in icons.js because
// that file is outside this change's allowed files. Same Lucide-style
// conventions as mapIcon: 2px round strokes on a 24 grid in currentColor,
// created with createElementNS so the paths parse as real SVG geometry.
// The three lights are the button's icon only — never a data claim about
// actual conditions.
function trafficIcon({ class: extra = 'h-5 w-5' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', extra);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<rect x="8" y="3" width="8" height="18" rx="4"/>' +
    '<path d="M12 7.5h.01"/><path d="M12 12h.01"/><path d="M12 16.5h.01"/>';
  return svg;
}

const BUTTON_CLASS =
  'un-touch-target flex h-11 w-11 items-center justify-center rounded-pill border border-line bg-surface text-ink shadow-sm transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60';

function iconButton({ icon, label, onClick }) {
  return el(
    'button',
    {
      type: 'button',
      class: BUTTON_CLASS,
      'aria-label': label,
      title: label,
      dataset: { mapControl: icon },
    },
    [mapIcon(icon), el('span', { class: 'sr-only', text: label })],
  );
  // eslint-disable-next-line no-unreachable
}

// Build the control column. Returns the element; handlers are wired by the
// caller through the callbacks so this stays a pure view.
export function mapControls({
  capabilities,
  onZoomIn,
  onZoomOut,
  onResetNorth,
  onMyLocation,
  onWeather,
  myLocationOn,
  onTraffic,
}) {
  const nodes = [
    buttonWithHandler(iconButton({ icon: 'plus', label: t('map.zoomIn') }), onZoomIn),
    buttonWithHandler(iconButton({ icon: 'minus', label: t('map.zoomOut') }), onZoomOut),
  ];
  if (capabilities.rotation) {
    nodes.push(
      buttonWithHandler(
        iconButton({ icon: 'compass', label: t('map.resetNorth') }),
        onResetNorth,
      ),
    );
  }
  nodes.push(
    el(
      'button',
      {
        type: 'button',
        class:
          'un-touch-target flex h-11 items-center gap-1.5 rounded-pill border border-line bg-surface px-3 text-xs font-medium text-ink shadow-sm transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'aria-label': t('map.myLocation'),
        'aria-pressed': myLocationOn ? 'true' : 'false',
        dataset: { mapControl: 'locate' },
      },
      [mapIcon('locate', { class: 'h-5 w-5' }), el('span', { text: t('map.myLocation') })],
    ),
  );
  // Weather (Phase 12G): opens the weather panel for the map centre. The
  // control is always offered while the map is live; what the panel reports
  // is the capability gate's decision, not the control's.
  nodes.push(
    buttonWithHandler(
      iconButton({ icon: 'weather', label: t('weather.controlSr') }),
      onWeather,
    ),
  );
  // Traffic (Phase 12D): opens the honest live-traffic panel. Not
  // capability-gated on purpose — the panel is exactly how the app answers
  // "is there live traffic?" while no provider is connected.
  nodes.push(
    el(
      'button',
      {
        type: 'button',
        class: BUTTON_CLASS,
        'aria-label': t('traffic.control'),
        title: t('traffic.control'),
        dataset: { mapControl: 'traffic' },
      },
      [trafficIcon(), el('span', { class: 'sr-only', text: t('traffic.control') })],
    ),
  );
  // Map layers is deliberately disabled and labelled: it is a placeholder for
  // a later phase, not a broken control.
  nodes.push(
    el(
      'button',
      {
        type: 'button',
        disabled: true,
        class: BUTTON_CLASS,
        'aria-label': t('map.layersSr'),
        title: t('common.comingSoon'),
        dataset: { mapControl: 'layers' },
      },
      [mapIcon('layers'), el('span', { class: 'sr-only', text: t('map.layersSr') })],
    ),
  );

  const column = el(
    'div',
    { class: 'flex flex-col items-end gap-2' },
    nodes,
  );
  // The My location and Traffic buttons have real actions; wire them here
  // since they were built inline above.
  const locate = column.querySelector('[data-map-control="locate"]');
  if (locate && onMyLocation) locate.addEventListener('click', onMyLocation);
  const traffic = column.querySelector('[data-map-control="traffic"]');
  if (traffic && onTraffic) traffic.addEventListener('click', onTraffic);
  return column;
}

function buttonWithHandler(node, handler) {
  if (handler) node.addEventListener('click', handler);
  return node;
}
