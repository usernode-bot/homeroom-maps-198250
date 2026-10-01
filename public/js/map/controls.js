// The map overlay controls, rendered into Home's existing top-right
// `data-map-controls` slot. Zoom in, zoom out, reset north and My location are
// real buttons; Map layers stays the disabled "Coming soon" placeholder.
//
// Which controls appear is driven by the adapter's capability flags: a device
// whose renderer cannot rotate simply has no reset-north button, rather than a
// control that does nothing.
import { el } from '../components/dom.js';
import { mapIcon } from './icons.js';

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
export function mapControls({ capabilities, onZoomIn, onZoomOut, onResetNorth, onMyLocation, myLocationOn }) {
  const nodes = [
    buttonWithHandler(iconButton({ icon: 'plus', label: 'Zoom in' }), onZoomIn),
    buttonWithHandler(iconButton({ icon: 'minus', label: 'Zoom out' }), onZoomOut),
  ];
  if (capabilities.rotation) {
    nodes.push(
      buttonWithHandler(
        iconButton({ icon: 'compass', label: 'Reset north' }),
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
        'aria-label': 'My location',
        'aria-pressed': myLocationOn ? 'true' : 'false',
        dataset: { mapControl: 'locate' },
      },
      [mapIcon('locate', { class: 'h-5 w-5' }), el('span', { text: 'My location' })],
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
        'aria-label': 'Map layers (coming soon)',
        title: 'Coming soon',
        dataset: { mapControl: 'layers' },
      },
      [mapIcon('layers'), el('span', { class: 'sr-only', text: 'Map layers, coming soon' })],
    ),
  );

  const column = el(
    'div',
    { class: 'flex flex-col items-end gap-2' },
    nodes,
  );
  // The My location button is the one with a real action; wire it here since
  // it was built inline above.
  const locate = column.querySelector('[data-map-control="locate"]');
  if (locate && onMyLocation) locate.addEventListener('click', onMyLocation);
  return column;
}

function buttonWithHandler(node, handler) {
  if (handler) node.addEventListener('click', handler);
  return node;
}
