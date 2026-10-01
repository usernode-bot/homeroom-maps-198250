// Location field — one search-backed endpoint row of the Directions form
// (the origin, the destination, or a waypoint).
//
// This is NOT a second search implementation: it is the Phase 2 search stack
// used through its existing interface. createSearchSession drives suggest /
// committed search and the shared recents; createSearchBar gives the combobox
// input; createSearchPanel renders loading / no-results / error / recents.
// The only Directions-specific part is what happens to a chosen result: it
// becomes the row's location point (via the Place adapter seam in
// routing-core.js) and the row switches to a chip view.
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { createSearchBar } from '../search/search-bar.js';
import { createSearchPanel } from '../search/search-results.js';
import { createSearchSession } from '../../services/search.js';
import { toLocationPoint } from '../../services/routing-core.js';

export function createLocationField({
  label,
  placeholder,
  iconName = 'pin',
  onPick,
  onClear,
}) {
  let point = null;

  const session = createSearchSession({
    onSelect: (result) => {
      // The chosen search result becomes the row's point. A result without
      // usable coordinates is refused here (the panel just stays open) —
      // no location is ever made up for it.
      const pt = toLocationPoint(result);
      session.removeSelected();
      session.clearInput();
      if (pt) onPick(pt);
    },
  });

  const bar = createSearchBar({
    onInput: (value) => session.input(value),
    onFocus: () => session.open(),
    onBlur: (e) => {
      if (!e.relatedTarget || !root.contains(e.relatedTarget)) session.close();
    },
    onKeydown: (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        session.move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        session.move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const state = session.getState();
        if (state.highlighted >= 0 && state.results[state.highlighted]) {
          session.select(state.results[state.highlighted]);
        } else {
          session.commit();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        session.escape();
        bar.input.blur();
      }
    },
    onClear: () => {
      session.clearInput();
      bar.input.focus();
    },
  });

  const panel = createSearchPanel({ session });

  const picker = el('div', { class: 'flex flex-col gap-1.5', dataset: { fieldPicker: 'true' } }, [
    bar.root,
    panel.root,
  ]);

  // The chip view: the chosen point, name + detail + Clear. Replacing the
  // input with a chip after a selection keeps the row compact and shows the
  // user exactly which place will be routed through.
  const chipName = el('p', { class: 'truncate text-sm font-medium text-ink' });
  const chipDetail = el('p', { class: 'truncate text-xs text-muted' });
  const chip = el(
    'div',
    { class: 'flex min-h-[46px] items-center gap-3 rounded-pill border border-line bg-surface px-4 py-2', dataset: { fieldChip: 'true' } },
    [
      icon(iconName, { class: 'h-4 w-4 shrink-0 text-brand' }),
      el('div', { class: 'min-w-0 flex-1' }, [chipName, chipDetail]),
    ],
  );
  const chipClear = el(
    'button',
    {
      type: 'button',
      class: 'shrink-0 rounded p-1.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-label': `Clear ${label.toLowerCase()}`,
      dataset: { fieldClear: 'true' },
    },
    [icon('close', { class: 'h-4 w-4' })],
  );
  chipClear.addEventListener('click', () => {
    setPoint(null);
    if (onClear) onClear();
    bar.input.focus();
  });
  chip.append(chipClear);

  const root = el('div', { class: 'flex flex-col gap-1.5', dataset: { locationField: 'true' } }, [
    el('p', { class: 'text-xs font-medium uppercase tracking-wide text-muted', text: label }),
    picker,
    chip,
  ]);

  function setPoint(next) {
    point = next;
    render();
  }

  function render() {
    const has = Boolean(point);
    chip.classList.toggle('hidden', !has);
    picker.classList.toggle('hidden', has);
    if (has) {
      chipName.textContent = point.name;
      chipDetail.textContent = point.detail || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
    }
    // A chosen point closes any open panel state so reopening the picker
    // starts clean from recents.
    if (has) session.close();
  }

  setPoint(point);

  // The session is the single source of truth; the bar and the panel only
  // react — the same wiring as the Search screen's bar+panel pair.
  session.subscribe((state) => {
    bar.update(state);
    panel.update(state);
  });

  return { root, setPoint, get point() { return point; }, focus: () => bar.input.focus() };
}
