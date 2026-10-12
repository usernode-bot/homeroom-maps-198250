// The 3D map toggles (Phase 12H), rendered into Home's existing control
// column between the compass and My location.
//
// Both are text pills in the My-location shape: a toggle with `aria-pressed`,
// where the pressed state is the brand fill, and a 44px touch target. They
// are rendered ONLY when the capability says they may exist — a capability a
// device or config cannot support never gets a control that does nothing,
// which is the same rule the zoom/compass controls follow.
//
// Pressed-state updates happen in place (set3DPressed / setTerrainPressed)
// rather than by rebuilding the column, so a tap re-renders one button, not
// the map's whole control stack.
import { el } from '../components/dom.js';
import { t } from '../i18n/index.js';

const PILL_BASE =
  'un-touch-target flex h-11 items-center rounded-pill border px-3 text-xs font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg';
const PILL_OFF = PILL_BASE + ' border-line bg-surface text-ink hover:bg-surface-raised';
const PILL_ON = PILL_BASE + ' border-brand bg-brand text-white';

// The pill's class for a pressed (on) or rest (off) state — exported so the
// screen can flip the state in place without rebuilding the control column.
export function pillClass(on) {
  return on ? PILL_ON : PILL_OFF;
}

function togglePill({ label, srLabel, control, on, onToggle }) {
  const node = el(
    'button',
    {
      type: 'button',
      class: pillClass(on),
      'aria-label': srLabel || label,
      'aria-pressed': on ? 'true' : 'false',
      title: label,
      dataset: { mapControl: control },
    },
    [el('span', { text: label })],
  );
  // The tap's target state comes from the LIVE aria-pressed, not the render-
  // time `on`: the screen flips the pill in place (setPressed) without
  // re-rendering it, so a closure over `on` would go stale after the first
  // tap and resend the same request forever.
  if (onToggle) {
    node.addEventListener('click', () => {
      onToggle(node.getAttribute('aria-pressed') !== 'true');
    });
  }
  return node;
}

// The 3D camera toggle. `on` is the current state (from the device-local
// preference); `onToggle(next)` receives the state the tap asks for.
export function threeDToggle({ on, onToggle }) {
  return togglePill({
    label: t('map.3dTitle'),
    control: '3d',
    on,
    onToggle,
  });
}

// The terrain elevation toggle. Its accessible name is the longer `terrainSr`
// line; the visible label stays the one-word control title.
export function terrainToggle({ on, onToggle }) {
  return togglePill({
    label: t('map.terrainTitle'),
    srLabel: t('map.terrainSr'),
    control: 'terrain',
    on,
    onToggle,
  });
}

// Flip a toggle pill's pressed state in place (class + aria-pressed).
export function setPressed(node, on) {
  if (!node) return;
  node.className = pillClass(on);
  node.setAttribute('aria-pressed', on ? 'true' : 'false');
}
