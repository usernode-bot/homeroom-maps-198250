// Home — the map-first screen, built as a frame rather than a map. Nothing
// here searches, centers or routes: the regions the finished product needs are
// present and honestly labelled, so the layout is ready for a real map later.
//
// Deferred (Phase 1+): the actual map canvas, place search and the two
// overlay controls wired to a map provider. `mapProvider` from /api/config is
// null, which is the signal this screen reads to decide it has no map.
import { el } from '../components/dom.js';
import { placeholderPanel } from '../components/placeholder-panel.js';

export async function render(ctx) {
  ctx.content.replaceChildren(
    el('h1', { class: 'sr-only', text: 'Home' }),

    // Search area. A real text input so the material is present, disabled
    // because search is not built, with an explicit "coming soon" label.
    el('div', { class: 'flex flex-col gap-1.5' }, [
      el('div', { class: 'relative' }, [
        el('input', {
          type: 'search',
          disabled: true,
          placeholder: 'Search places',
          'aria-label': 'Search places',
          class:
            'w-full rounded-pill border border-line bg-surface px-4 py-3 text-sm text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-70',
        }),
      ]),
      el('p', { class: 'px-1 text-xs text-muted', text: 'Search coming soon' }),
    ]),

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
