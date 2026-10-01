// Home — the map-first screen. It owns the map frame and the overlay controls,
// and asks the map service for a live MapAdapter. The service and adapter
// report which of the map states applies; this screen renders that state using
// the app's existing components (the loading skeleton, the shared error state)
// so nothing here invents new chrome.
//
// Search is live: typing queries the app's own search service (see
// services/search.js), suggestions open in a panel below the input, a chosen
// suggestion shows as the Selected place card.
//
// Deferred: "Search this area" and "Nearby" controls, and centering the map
// on a selected search result. The search service already exposes
// searchInView(bbox) and searchNear(lat, lon, km) and the server routes
// accept them; only the map-anchored UI is missing. The disabled "Map
// layers" control stays as a labelled placeholder.
import { el } from '../components/dom.js';
import { errorState } from '../components/error-state.js';
import { loading } from '../components/loading.js';
import { placeholderPanel } from '../components/placeholder-panel.js';
import { getState } from '../state.js';
import { createMapService } from '../services/map.js';
import { MapErrorKind } from '../map/errors.js';
import { attributionParts, rendererLink } from '../map/attribution.js';
import { mapControls } from '../map/controls.js';
import { createSearchSession } from '../services/search.js';
import { createSearchBar } from '../components/search/search-bar.js';
import { createSearchPanel, selectedPlaceCard } from '../components/search/search-results.js';
import { t } from '../i18n/index.js';
import { formatDistance } from '../i18n/format.js';

const DEFAULT_ATTRIBUTION = 'OpenFreeMap, OpenMapTiles, OpenStreetMap';

// The live map for the screen currently mounted. Torn down on the next render
// so a navigation never leaves a WebGL context or tile poller behind.
let activeService = null;

// PLACEHOLDER(map-phase): the map adapter exists now, but centering it on a
// selected search result and dropping a marker aren't wired yet — this hook
// is the single seam for that.
function focusSelectedPlace(_place) {}

export async function render(ctx) {
  if (activeService) {
    activeService.destroy();
    activeService = null;
  }

  const mapConfig = (getState().config && getState().config.map) || null;
  const force = demoState();

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

  // The frame keeps ONE definite height across every state, so switching
  // between them never collapses or jumps the page and the renderer always has
  // a real box to size its canvas to. It is a definite height (not min-height)
  // on purpose: the renderer's own `.maplibregl-map` rule forces
  // `position: relative` on the surface below, so the surface sits in normal
  // flow and a percentage height only resolves against a definite parent.
  // With `min-height` the surface (and MapLibre's own `overflow: hidden` box)
  // resolves to zero height and clips the canvas away, which is exactly the
  // "container and controls render but no tiles" failure.
  const container = el('div', {
    class: 'relative h-[60vh] overflow-hidden rounded-card border border-line bg-surface-raised',
    dataset: { mapContainer: 'live' },
  });
  // `surface` is the map region: it carries the descriptive label and the
  // `role="img"` the region is meant to keep for assistive tech, and the
  // `data-map-canvas` hook a check can find in every state. The renderer owns
  // it and it stays otherwise empty; the loading, message and error states are
  // siblings in `overlay`, so they remain readable to a screen reader rather
  // than being swallowed by `role="img"`. `overlay` is hidden once the map is
  // live.
  //
  // It fills the frame with `h-full w-full` rather than `absolute inset-0` on
  // purpose: MapLibre's own stylesheet re-positions whatever element it is
  // handed as `position: relative` and clips it with `overflow: hidden`, so
  // the absolute variant would win the position but still resolve to zero
  // height and clip the canvas to nothing. Filling the definite parent works
  // whether the renderer keeps it relative or an adapter positions it
  // absolutely, so it stays correct across renderers.
  const surface = el('div', {
    class: 'h-full w-full',
    dataset: { mapCanvas: 'true' },
    role: 'img',
    'aria-label': t('map.srLabel'),
  });
  const overlay = el('div', {
    class: 'absolute inset-0 flex flex-col justify-center bg-surface-raised',
    dataset: { mapOverlay: 'true' },
    // Announced politely as loading gives way to a map or an error.
    'aria-live': 'polite',
  });
  const controls = el('div', {
    class: 'pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end',
    dataset: { mapControls: 'live' },
  });
  const note = el('p', {
    class: 'px-1 text-xs text-muted',
    dataset: { mapNote: 'true' },
    role: 'status',
    'aria-live': 'polite',
  });
  note.style.display = 'none';

  const attribution = el('p', {
    class:
      'px-1 text-[11px] leading-relaxed text-muted [&_a]:text-brand [&_a]:underline',
    dataset: { mapAttribution: 'true' },
  });

  container.append(surface, overlay, controls);

  ctx.content.replaceChildren(
    el('h1', { class: 'sr-only', text: t('nav.home') }),

    // Live search area: the input, the results panel beneath it, and the
    // Selected place card slot above the map frame.
    el('div', { class: 'flex flex-col gap-1.5', dataset: { search: 'true' } }, [
      bar.root,
      panel.root,
    ]),
    selectedSlot,

    container,
    note,
    attribution,

    placeholderPanel({
      title: t('home.placesTitle'),
      description: t('home.placesBody'),
    }),
  );

  sync(session.getState());

  const config = mapConfig && mapConfig.configured
    ? mapConfig
    : {
        configured: false,
        provider: null,
        label: null,
        styleUrl: null,
        styleUrlDark: null,
        attribution: DEFAULT_ATTRIBUTION,
        capabilities: { rotation: false, touchGestures: false, accuracyCircle: false },
      };

  // The app's own attribution strip is rendered up front from config, so it is
  // correct and visible even while the map is loading or has failed. This is
  // what satisfies the data licence when tiles never arrive.
  renderAttribution(attribution, config.attribution || DEFAULT_ATTRIBUTION);

  const view = { container, surface, overlay, controls, note };

  // A forced demo state short-circuits the real path only for the state it
  // names; every other route mounts the live adapter through the service.
  if (force === 'unconfigured') {
    showMessage(view, 'unconfigured');
    return;
  }

  mountMap(view, config, force === 'unsupported' ? 'unsupported' : null);
}

function mountMap(view, config, force = null) {
  // A retry builds a fresh adapter; drop the previous one first so its WebGL
  // context and renderer DOM do not stack up behind the new map.
  if (activeService) {
    activeService.destroy();
    activeService = null;
  }
  showOverlay(view, loading({ label: t('map.loading') }));
  const service = createMapService(config, {
    force,
    onState: (state, err) => {
      if (activeService !== service) return;
      if (state === 'ready') onReady(service, view);
      else if (state === 'error') onFailure(service, view, err);
    },
  });
  activeService = service;
  service.mount(view.surface).catch((err) => {
    if (activeService === service) onFailure(service, view, err);
  });
}

function onReady(service, view) {
  hideOverlay(view);
  view.controls.replaceChildren(liveControls(service, view));
}

function onFailure(service, view, err) {
  if (activeService !== service) return;
  const kind = (err && err.kind) || MapErrorKind.STYLE_ERROR;

  if (kind === MapErrorKind.UNSUPPORTED_DEVICE) {
    showMessage(view, 'unsupported');
    return;
  }
  if (kind === MapErrorKind.NOT_CONFIGURED) {
    showMessage(view, 'unconfigured');
    return;
  }

  // Network failure, provider rejection and a malformed style all render the
  // shared error state, with a plain-language reason and a Try again action
  // that re-mounts the map. Never a raw stack.
  view.controls.replaceChildren(disabledControls());
  showOverlay(
    view,
    errorState({
      title:
        kind === MapErrorKind.PROVIDER
          ? t('map.errorProviderTitle')
          : t('map.errorTitle'),
      description: (err && err.message) || t('map.errorBody'),
      onRetry: () => mountMap(view, service.currentConfig()),
    }),
  );
  if (err && err.detail) console.warn('[map] ' + kind + ': ' + err.detail);
}

// A state-specific message inside the frame, keeping the frame's height so the
// page never collapses or jumps.
function showMessage(view, kind) {
  const copy = {
    unconfigured: {
      title: t('map.unconfiguredTitle'),
      body: t('map.unconfiguredBody'),
    },
    unsupported: {
      title: t('map.unsupportedTitle'),
      body: t('map.unsupportedBody'),
    },
  }[kind];
  view.controls.replaceChildren(disabledControls());
  showOverlay(
    view,
    el(
      'div',
      {
        class:
          'flex h-full flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line p-6 text-center',
      },
      [
        el('p', { class: 'text-base font-semibold text-ink', text: copy.title }),
        el('p', { class: 'max-w-sm text-sm text-muted leading-relaxed', text: copy.body }),
      ],
    ),
  );
}

// The overlay carries a `flex` display class, which outranks the UA stylesheet's
// `[hidden]` rule, so visibility is toggled with `display` directly rather than
// the `hidden` attribute.
function showOverlay(view, node) {
  view.overlay.style.display = '';
  view.overlay.replaceChildren(node);
}

function hideOverlay(view) {
  view.overlay.replaceChildren();
  view.overlay.style.display = 'none';
}

function liveControls(service, view) {
  const column = mapControls({
    capabilities: service.capabilities(),
    myLocationOn: false,
    onZoomIn: () => service.zoomIn(),
    onZoomOut: () => service.zoomOut(),
    onResetNorth: () => service.resetNorth(),
    onMyLocation: () => requestLocation(service, view),
  });
  column.classList.add('pointer-events-auto');
  return column;
}

function disabledControls() {
  return el('div', { class: 'pointer-events-auto' }, [
    el(
      'button',
      {
        type: 'button',
        disabled: true,
        class:
          'un-touch-target flex h-11 items-center gap-1.5 rounded-pill border border-line bg-surface px-3 text-xs font-medium text-muted shadow-sm disabled:cursor-not-allowed disabled:opacity-70',
        title: t('common.comingSoon'),
        dataset: { mapControl: 'layers' },
      },
      [el('span', { text: t('map.layers') })],
    ),
  ]);
}

// ── attribution ──────────────────────────────────────────────────────────

function renderAttribution(node, text) {
  if (!node) return;
  const parts = attributionParts(text);
  const children = [el('span', { text: t('map.dataPrefix') })];
  parts.forEach((part, i) => {
    if (i > 0) children.push(document.createTextNode(' · '));
    children.push(
      part.href
        ? el('a', { href: part.href, target: '_blank', rel: 'noopener noreferrer', text: part.label })
        : el('span', { text: part.label }),
    );
  });
  children.push(document.createTextNode(' · '));
  children.push(
    el('a', {
      href: rendererLink(),
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'MapLibre',
    }),
  );
  node.replaceChildren(...children);
}

// ── user location ────────────────────────────────────────────────────────

// The permission flow is exact. Ask at the moment of need (the tap), never at
// startup. Distinguish a denial from an ordinary failure, and never tell
// someone to check a permission they were never asked for.
async function requestLocation(service, view) {
  const usernode = window.usernode;

  if (!usernode || typeof usernode.requestPermission !== 'function') {
    // Standalone (no platform shell): a permission request would reject the
    // same way a denial does, so say the platform is needed instead of
    // pretending the user said no.
    toast(t('map.needShell'), { error: true });
    return;
  }

  let result;
  try {
    result = await usernode.requestPermission('geolocation');
  } catch (err) {
    toast(t('map.askFailed'), { error: true });
    return;
  }

  if (!result || result.state !== 'granted') {
    // `declined` is the person saying no; `not_declared` would mean our
    // manifest is wrong (a bug). Either way the map stays usable.
    const message =
      result && result.reason === 'declined' ? t('map.declined') : t('map.notAvailable');
    showNote(view, message);
    toast(message, { error: true });
    return;
  }

  if (result.active === false) {
    // Granted, and the shell is about to reload this frame to apply the
    // policy. Stop here: calling the geolocation API now would fail.
    toast(t('map.grantedReloading'), {});
    return;
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    toast(t('map.noGeolocation'), { error: true });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      service.setUserLocation({ lat: latitude, lng: longitude, accuracy });
      service.centerOn({ lat: latitude, lng: longitude }, 14);
      showNote(
        view,
        typeof accuracy === 'number' && accuracy > 0
          ? t('map.showingAccuracy', { distance: formatDistance(accuracy) })
          : t('map.showing'),
      );
    },
    (err) => {
      // A PERMISSION_DENIED here is ambiguous: it is also what a rejected
      // promise from an undelegated capability carries, which looks identical
      // to a person tapping block. hasCapability reads this document's own
      // policy, so it separates "never asked / not delegated" from a genuine
      // denial and we never tell someone to check a permission they were
      // never asked for. Anything else (POSITION_UNAVAILABLE, a timeout) is
      // "location unavailable".
      const denied = err && err.code === err.PERMISSION_DENIED;
      const documentHolds = typeof window.usernode?.hasCapability === 'function'
        && window.usernode.hasCapability('geolocation');
      const message = denied && documentHolds ? t('map.denied') : t('map.locateFailed');
      showNote(view, message);
      toast(message, { error: true });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

function showNote(view, message) {
  view.note.style.display = '';
  view.note.textContent = message;
}

function toast(message, { error = false } = {}) {
  const kit = window.unNative;
  if (kit && typeof kit.toast === 'function') {
    try {
      kit.toast(message, error ? { error: true } : {});
      return;
    } catch {
      /* fall through to a console note */
    }
  }
  console.info('[map] ' + message);
}

// ── lifecycle ────────────────────────────────────────────────────────────

// The state lives in the query string, but this app hash-routes, so the
// declared check path carries it after the `#` (`/#/?map=unconfigured`). Read
// both so the demo route works however it is linked.
function demoState() {
  let value = null;
  try {
    value = new URLSearchParams(window.location.search).get('map');
    if (!value) {
      const hash = window.location.hash.replace(/^#/, '');
      const q = hash.indexOf('?');
      if (q >= 0) value = new URLSearchParams(hash.slice(q + 1)).get('map');
    }
  } catch {
    /* no URL, no demo state */
  }
  return value === 'unconfigured' || value === 'unsupported' ? value : null;
}

// Swap the basemap style when the platform theme changes, keeping the camera
// where it is. The renderer preserves camera position across setStyle.
window.addEventListener('usernode:theme-changed', () => {
  if (!activeService) return;
  const config = activeService.currentConfig();
  if (!config || !config.styleUrlDark) return;
  const dark = document.documentElement.classList.contains('dark');
  activeService.setStyle(dark ? config.styleUrlDark : config.styleUrl);
});
