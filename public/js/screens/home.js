// Home — the map-first screen. Search is live: typing queries the app's own
// search service (see services/search.js), suggestions open in a panel below
// the input, a chosen suggestion shows as the Selected place card. The map
// frame is still an honest placeholder: no map provider is connected
// (`mapProvider: null` from /api/config), so nothing here centers a map.
//
// Deferred (map phase): "Search this area" and "Nearby" controls. The search
// service already exposes searchInView(bbox) and searchNear(lat, lon, km) and
// the server routes accept them; only the map-anchored UI is missing.
import { el } from '../components/dom.js';
import { placeholderPanel } from '../components/placeholder-panel.js';
import { createSearchSession } from '../services/search.js';
import { createSearchBar } from '../components/search/search-bar.js';
import { createSearchPanel, selectedPlaceCard } from '../components/search/search-results.js';

// PLACEHOLDER(map-phase): until a map provider is connected, the honest end
// of a selection is the Selected place card. When the map phase lands, this
// hook is the single seam that also centres the map on the result's
// coordinates and shows a marker (services/map.js is interface-only today;
// /api/config still reports mapProvider: null).
function focusSelectedPlace(_place) {}

export async function render(ctx) {
  const session = createSearchSession({ onSelect: focusSelectedPlace });

  const bar = createSearchBar({
    onInput: (value) => session.input(value),
    onFocus: () => session.open(),
    onBlur: (e) => {
      // Closing on blur, unless focus moved into the panel (option clicks
      // keep the input focused via mousedown preventDefault, so this only
      // fires for genuinely outside targets like Tab or a click elsewhere).
      if (!e.relatedTarget || !panel.root.contains(e.relatedTarget)) {
        session.close();
      }
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
      }
    },
    onClear: () => {
      session.clearInput();
      bar.input.focus();
    },
  });

  const panel = createSearchPanel({ session });

  const selectedSlot = el('div', { class: 'contents', dataset: { selectedPlace: 'slot' } });

  function sync(state) {
    bar.update(state);
    panel.update(state);
    selectedSlot.replaceChildren(
      state.selected ? selectedPlaceCard({ place: state.selected, onRemove: () => session.removeSelected() }) : [],
    );
  }
  session.subscribe(sync);

  ctx.content.replaceChildren(
    el('h1', { class: 'sr-only', text: 'Home' }),

    // Live search area: the input, the results panel beneath it, and the
    // Selected place card slot above the map frame.
    el('div', { class: 'flex flex-col gap-1.5', dataset: { search: 'true' } }, [
      bar.root,
      panel.root,
    ]),
    selectedSlot,

    // Map container. An empty, labelled frame — never a fake map, tile image
    // or provider SDK. The floating controls are disabled placeholders.
    el('div', { class: 'relative' }, [
      el(
        'div',
        {
          class:
            'flex min-h-[46vh] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line bg-surface-raised/60 p-6 text-center',
          dataset: { mapContainer: 'placeholder' },
          role: 'img',
          'aria-label': 'Map canvas placeholder',
        },
        [
          el('p', { class: 'text-base font-semibold text-ink', text: 'Map' }),
          el('p', {
            class: 'max-w-sm text-sm text-muted leading-relaxed',
            text: 'Map canvas coming soon. No map provider is connected yet.',
          }),
        ],
      ),
      el(
        'div',
        { class: 'absolute right-3 top-3 flex flex-col gap-2', dataset: { mapControls: 'placeholder' } },
        [
          placeholderControl('My location'),
          placeholderControl('Map layers'),
        ],
      ),
    ]),

    placeholderPanel({
      title: 'Places',
      description:
        'Points of interest, saved places and map contributions will appear here once the map is connected.',
    }),
  );

  sync(session.getState());
}

// A disabled overlay control on the map frame. Purely a placeholder: it has
// no handler and cannot be activated.
function placeholderControl(label) {
  return el(
    'button',
    {
      type: 'button',
      disabled: true,
      class:
        'rounded-pill border border-line bg-surface px-3 py-1.5 text-xs font-medium text-muted shadow-sm disabled:cursor-not-allowed disabled:opacity-70',
      title: 'Coming soon',
    },
    [label],
  );
}