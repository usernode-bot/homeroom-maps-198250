// Directions — plan a route: choose an origin, a destination and optional
// waypoints, pick a travel mode, and see the real route the routing provider
// returned drawn on the map.
//
// Architecture, per the platform spec: the screen talks ONLY to services —
//   RoutingService (services/routing.js -> /api/directions -> routing/ on the
//     server -> the configured RoutingProvider adapter),
//   SearchService (through the existing search components and session),
//   MapService (services/map.js -> the existing MapAdapter, extended with
//     setRoutes / fitBounds),
//   LocationService (services/location.js, the device fix for "My location").
// No provider knowledge and no renderer knowledge lives here, and nothing is
// ever fabricated: every distance, duration, road name and route line comes
// from the provider's response, and a missing value reads "unavailable".
//
// Turn-by-turn navigation (Phase 8) reuses everything this screen already
// owns: the calculated RouteResult goes into the navigation session unchanged,
// the same map instance draws guidance, and the planning form steps aside
// while a session is live.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { errorState } from '../components/error-state.js';
import { t } from '../i18n/index.js';
import { spinner } from '../components/loading.js';
import { icon } from '../components/icons.js';
import { createLocationField } from '../components/directions/location-field.js';
import { modeSelector } from '../components/directions/mode-selector.js';
import { routeSummary } from '../components/route-summary.js';
import { createNavigationView } from '../components/navigation/view.js';
import { getState } from '../state.js';
import { hashParams } from '../router.js';
import { capabilitiesFromConfig, createDirectionsSession } from '../services/routing.js';
import {
  currentLocationPoint,
  toLocationPoint,
  geometryBounds,
  ROUTE_ERROR_COPY,
} from '../services/routing-core.js';
import { getCurrentLocation, LocationError } from '../services/location.js';
import { createNavigation, NAV_STATE } from '../services/navigation.js';
import { createMapService } from '../services/map.js';
import { listReports } from '../services/community.js';
import {
  activeJamReports,
  coverageForGeometry,
  routeConditions,
  TRAFFIC_JAM_COLOR,
  TRAFFIC_CLEAR_COLOR,
} from '../services/traffic.js';
import { MapErrorKind } from '../map/errors.js';
import { attributionParts, rendererLink } from '../map/attribution.js';

const DEFAULT_ATTRIBUTION = 'OpenStreetMap';

// The traffic check's own knobs (request #26): how long a nearby feed
// answer is reused across route re-applies, and the reports API's own
// nearby-radius cap (reports/model.js LIMITS.nearbyRadiusKmMax), which the
// request is clamped to for very long routes.
const TRAFFIC_CACHE_MS = 60000;
const NEARBY_RADIUS_CAP_KM = 200;

// The live map for the screen currently mounted. Torn down on the next render
// of this screen, so a navigation never leaves a WebGL context behind (the
// same pattern the Home screen uses).
let activeService = null;

// The live navigation session, with its view and listeners. Ended on the next
// render of this screen: leaving the Directions screen always stops guidance,
// its location watch and its voice.
let activeNavigation = null;

const ERROR_TITLES = {
  missing_origin: 'Route not ready',
  missing_destination: 'Route not ready',
  invalid_request: 'Invalid route request',
  no_route: 'No route found',
  unsupported_mode: 'Travel mode unavailable',
  rate_limited: 'Routing is busy right now',
  timeout: 'The route took too long',
  network: 'We could not reach the routing service',
  provider: 'Route calculation failed',
};

export async function render(ctx) {
  if (activeNavigation) {
    const nav = activeNavigation;
    activeNavigation = null;
    window.removeEventListener('usernode:visibility-changed', nav.onVisibility);
    if (nav.unsubIdle) nav.unsubIdle();
    nav.view.destroy();
    nav.session.end();
  }
  if (activeService) {
    activeService.destroy();
    activeService = null;
  }

  const config = getState().config || {};
  const capabilities = capabilitiesFromConfig(config);
  const mapConfig = config.map || null;

  // Not configured: say so plainly instead of rendering a form whose every
  // action would fail. The provider, when one exists, is a server
  // configuration change away.
  if (!capabilities || !capabilities.modes.length) {
    ctx.content.replaceChildren(
      el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: 'Directions' }),
      errorState({
        title: 'Routing is not configured yet',
        description:
          'No routing provider is connected. Set ROUTING_PROVIDER on the server to turn directions on.',
      }),
    );
    return;
  }

  const session = createDirectionsSession({ config });

  // ── endpoint fields ──────────────────────────────────────────────────────
  const originField = createLocationField({
    label: 'Origin',
    placeholder: 'Search for a starting point',
    onPick: (point) => session.setOrigin(point),
    onClear: () => session.clearOrigin(),
  });
  const destinationField = createLocationField({
    label: 'Destination',
    placeholder: 'Search for a destination',
    onPick: (point) => session.setDestination(point),
    onClear: () => session.clearDestination(),
  });

  const waypointHost = el('div', {
    class: 'flex flex-col gap-3',
    dataset: { waypoints: 'true' },
  });
  const waypointNote = el('p', {
    class: 'text-xs text-muted leading-relaxed',
    dataset: { waypointNote: 'true' },
  });
  waypointNote.style.display = 'none';

  // ── mode selector ────────────────────────────────────────────────────────
  const modeHost = el('div', { dataset: { modeHost: 'true' } });

  // ── actions ──────────────────────────────────────────────────────────────
  const swapButton = el(
    'button',
    {
      type: 'button',
      class:
        'inline-flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
      'aria-label': 'Swap origin and destination',
      title: 'Swap origin and destination',
      dataset: { swap: 'true' },
    },
    [icon('swap', { class: 'h-4 w-4' })],
  );
  swapButton.addEventListener('click', () => session.swap());

  const myLocationButton = button('My location', {
    variant: 'secondary',
    attrs: { dataset: { myLocation: 'true' } },
  });
  myLocationButton.addEventListener('click', () => useCurrentLocation());

  const calculateButton = button('Show route', {
    attrs: { dataset: { showRoute: 'true' } },
  });
  calculateButton.addEventListener('click', () => session.calculate());

  const clearButton = button('Clear all', {
    variant: 'ghost',
    attrs: { dataset: { clearRoute: 'true' } },
  });
  clearButton.addEventListener('click', () => session.clearAll());

  const addWaypointButtonNode = buildAddWaypointButton(session);

  // ── results + map ────────────────────────────────────────────────────────
  const resultsSlot = el('div', {
    class: 'flex flex-col gap-3',
    dataset: { routeResults: 'true' },
    'aria-live': 'polite',
  });
  // The traffic legend (request #26): hidden until a route shows AND the
  // community-reports traffic check has answered. The route map drives it;
  // it lives in the planning host so it hides with the form during live
  // navigation.
  const trafficLegend = el('div', {
    class: 'flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted',
    dataset: { trafficLegend: 'true' },
  });
  trafficLegend.style.display = 'none';
  // The map frame reads the session through this getter; the derived phase
  // rides along because the raw state does not carry it.
  const routeMap = createRouteMap(mapConfig, () => ({
    ...session.getState(),
    phase: session.phase(),
  }), trafficLegend);

  // ── sync ─────────────────────────────────────────────────────────────────
  let lastWaypointCount = -1;
  let waypointFields = []; // field refs for the session's waypoint rows
  let pendingWaypoint = null; // { field, row } — an "Add waypoint" row awaiting a pick
  let autoNavPending = false; // a `?navigate=1` link waiting for its route

  function sync(state) {
    // A live navigation session owns the screen: the view renders from the
    // navigation snapshots, and the planning layout stands by hidden.
    if (activeNavigation) return;
    originField.setPoint(state.origin);
    destinationField.setPoint(state.destination);
    syncWaypoints(state);
    syncMode(state);
    renderResults(state);
    routeMap.update(state);
    if (session.phase() === 'routes' && navControlsHost.childElementCount) {
      navControlsHost.replaceChildren();
    }

    calculateButton.disabled = state.pending;
    if (autoNavPending) {
      const phase = session.phase();
      if (phase === 'routes') {
        autoNavPending = false;
        enterNavigation(state.routes[state.selectedRoute], state);
      } else if (phase === 'error') {
        autoNavPending = false;
      }
    }
  }
  session.subscribe(sync);

  // ── navigation lifecycle ─────────────────────────────────────────────────

  // Guidance reuses this screen's own map instance: the view mounts its
  // overlay inside the map frame and updates the same service the planning
  // map used. The session is created fresh here and bound to the real
  // fetcher and location watch by services/navigation.js.
  function enterNavigation(route, state) {
    if (activeNavigation || !route || !state || !state.destination) return;
    const { session: navSession, voice } = createNavigation();
    const ok = navSession.start(route, {
      destination: { lat: state.destination.lat, lon: state.destination.lon },
      waypoints: (state.waypoints || []).map((w) => ({ lat: w.lat, lon: w.lon })),
      mode: state.mode,
      waypointsSupported: session.waypointsSupported(),
    });
    if (!ok) {
      // An invalid route can never be guided; the session reset itself and
      // the planning screen stays as it was.
      navSession.end();
      return;
    }
    const view = createNavigationView({ session: navSession, voice, routeMap });
    const onVisibility = (event) => {
      navSession.setVisible(!event.detail || event.detail.hidden !== true);
    };
    const unsubIdle = navSession.subscribe((snap) => {
      // session.end() (the End button, or teardown) lands back in idle: put
      // the planning screen back.
      if (snap && snap.state === NAV_STATE.IDLE && activeNavigation === nav) {
        teardownNavigation(false);
      }
    });
    const nav = { session: navSession, view, onVisibility, unsubIdle };
    activeNavigation = nav;

    planningHost.style.display = 'none';
    navControlsHost.replaceChildren();
    view.subscribe();
    window.addEventListener('usernode:visibility-changed', onVisibility);
  }

  function teardownNavigation(endSession) {
    const nav = activeNavigation;
    if (!nav) return;
    activeNavigation = null;
    window.removeEventListener('usernode:visibility-changed', nav.onVisibility);
    if (nav.unsubIdle) nav.unsubIdle();
    nav.view.destroy();
    if (endSession) nav.session.end();
    planningHost.style.display = '';
    navControlsHost.replaceChildren();
    sync(session.getState());
    routeMap.refresh();
  }

  // ── static layout ────────────────────────────────────────────────────────
  const planningHost = el('div', { class: 'flex flex-col gap-4', dataset: { directionsPlanning: 'true' } }, [
    el('div', { class: 'flex flex-col gap-4', dataset: { directionsForm: 'true' } }, [
      modeHost,
      originField.root,
      el('div', { class: 'flex justify-center' }, [swapButton]),
      destinationField.root,
      el('div', { class: 'flex flex-col gap-2' }, [
        waypointHost,
        waypointNote,
        addWaypointButtonNode,
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-3' }, [
        myLocationButton,
        calculateButton,
        clearButton,
      ]),
    ]),
    resultsSlot,
    trafficLegend,
  ]);
  // Deep-link notes ("Navigation needs a route") and any navigation-mode
  // messaging that is not part of the live banner.
  const navControlsHost = el('div', {
    class: 'flex flex-col gap-3',
    dataset: { navigationControlsHost: 'true' },
  });

  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.directions') }),
    planningHost,
    routeMap.root,
    navControlsHost,
  );

  // ── Place integration adapter (PLACEHOLDER place-phase) ──────────────────
  // A Place Detail screen (Phase 3, not merged on this branch yet) hands a
  // place over by opening Directions with `?to=<encoded name>,<lat>,<lon>`.
  // The destination is pre-filled from the real place; nothing is looked up
  // or invented here. `?from=` pre-fills the origin the same way, and
  // `?navigate=1` asks for navigation as soon as a route exists.
  const prefill = parsePointParam('to');
  if (prefill) {
    session.setDestination(prefill);
  }
  const originLink = parsePointParam('from');
  if (originLink) {
    session.setOrigin(originLink);
  }
  if (hashParams().get('navigate') === '1') {
    const state = session.getState();
    if (state.origin && state.destination) {
      autoNavPending = true;
      session.calculate();
    } else {
      navControlsHost.replaceChildren(
        errorState({
          title: t('navigation.needsRoute'),
          description: t('navigation.needsRouteBody'),
        }),
      );
    }
  } else {
    sync(session.getState());
  }

  // ── waypoints ────────────────────────────────────────────────────────────

  function buildAddWaypointButton(sess) {
    if (!sess.waypointsSupported()) {
      return el('p', {
        class: 'text-xs text-muted leading-relaxed',
        dataset: { waypointUnsupported: 'true' },
        text: `Waypoints are not supported by the ${capabilities.label} provider.`,
      });
    }
    const add = button('Add waypoint', {
      variant: 'secondary',
      attrs: { dataset: { addWaypoint: 'true' } },
    });
    add.addEventListener('click', () => {
      const state = sess.getState();
      if (state.waypoints.length >= 5) return;
      if (pendingWaypoint) {
        pendingWaypoint.field.focus();
        return;
      }
      openPendingWaypoint(state.waypoints.length);
    });
    return add;
  }

  // A new waypoint starts as an empty picker row. It belongs to the screen
  // only until a place is picked (then it enters the session and the rows
  // rebuild) or is discarded; an empty waypoint is never carried into a
  // route request, so nothing here pretends it is.
  function openPendingWaypoint(index) {
    const field = createLocationField({
      label: `Waypoint ${index + 1}`,
      placeholder: 'Search for a waypoint',
      onPick: (pt) => session.addWaypoint(pt),
    });
    const discard = iconButton('close', 'Discard waypoint', () => {
      pendingWaypoint = null;
      if (row.parentNode) row.remove();
    });
    const row = el(
      'div',
      {
        class: 'flex items-start justify-between gap-2',
        dataset: { waypointPending: 'true' },
      },
      [
        el('div', { class: 'min-w-0 flex-1' }, [field.root]),
        el('div', { class: 'flex items-center gap-1' }, [discard]),
      ],
    );
    pendingWaypoint = { field, row };
    waypointHost.append(row);
    field.focus();
  }

  // Keep the waypoint rows in step with the session's list. Rows are rebuilt
  // only when the list length changes, so typing in a waypoint's search
  // field is never clobbered by an unrelated emit; a swap or reorder (same
  // length, different points) updates each row's chip in place.
  function syncWaypoints(state) {
    if (state.waypoints.length !== lastWaypointCount) {
      lastWaypointCount = state.waypoints.length;
      pendingWaypoint = null; // a rebuild replaces the pending row
      waypointFields = [];
      waypointHost.replaceChildren();
      state.waypoints.forEach((point, index) => {
        const { row, field } = waypointRow(point, index, state.waypoints.length);
        waypointFields.push(field);
        waypointHost.append(row);
      });
      if (addWaypointButtonNode.tagName === 'BUTTON') {
        addWaypointButtonNode.disabled = state.waypoints.length >= 5;
      }
      waypointNote.style.display = state.waypoints.length >= 5 ? '' : 'none';
      waypointNote.textContent = 'Up to 5 waypoints are supported.';
      return;
    }
    state.waypoints.forEach((point, i) => {
      if (waypointFields[i]) waypointFields[i].setPoint(point);
    });
  }

  function waypointRow(point, index, count) {
    const field = createLocationField({
      label: `Waypoint ${index + 1}`,
      placeholder: 'Search for a waypoint',
      onPick: (pt) => session.addWaypoint(pt),
      onClear: () => session.removeWaypoint(index),
    });
    field.setPoint(point);
    const up = iconButton('arrow-up', `Move waypoint ${index + 1} up`, () =>
      session.moveWaypoint(index, index - 1));
    const down = iconButton('arrow-down', `Move waypoint ${index + 1} down`, () =>
      session.moveWaypoint(index, index + 1));
    const remove = iconButton('close', `Remove waypoint ${index + 1}`, () =>
      session.removeWaypoint(index));
    up.disabled = index === 0;
    down.disabled = index === count - 1;
    const actions = el('div', { class: 'flex items-center gap-1' }, [up, down, remove]);
    const row = el(
      'div',
      { class: 'flex items-start justify-between gap-2', dataset: { waypointRow: String(index) } },
      [el('div', { class: 'min-w-0 flex-1' }, [field.root]), actions],
    );
    return { row, field };
  }

  function iconButton(name, label, onClick) {
    const node = el(
      'button',
      {
        type: 'button',
        class:
          'flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40',
        'aria-label': label,
        title: label,
      },
      [icon(name, { class: 'h-4 w-4' })],
    );
    node.addEventListener('click', onClick);
    return node;
  }

  // ── travel mode + results ────────────────────────────────────────────────

  function syncMode(state) {
    modeHost.replaceChildren(
      modeSelector({
        supportedModes: session.supportedModes(),
        unsupportedModes: session.unsupportedModes(),
        providerLabel: capabilities.label,
        mode: state.mode,
        onModeChange: (m) => session.setMode(m),
      }),
    );
  }

  function renderResults(state) {
    const phase = session.phase();
    if (phase === 'routing') {
      resultsSlot.replaceChildren(
        el('div', { class: 'flex items-center gap-3', dataset: { routeLoading: 'true' } }, [
          spinner(),
          el('p', { class: 'text-sm text-muted', text: 'Finding the best route…' }),
        ]),
      );
      return;
    }
    if (phase === 'error') {
      const err = state.error;
      const local = err && (err.kind === 'missing_origin' || err.kind === 'missing_destination');
      resultsSlot.replaceChildren(
        errorState({
          title: (err && (ERROR_TITLES[err.kind] || err.message)) || 'Route calculation failed',
          description: (err && err.message) || ROUTE_ERROR_COPY[err.kind] || '',
          // A missing endpoint is fixed by choosing one; the form is the way
          // forward, so no Try again button pretends otherwise.
          onRetry: local ? undefined : () => session.retry(),
        }),
      );
      return;
    }
    if (phase === 'routes') {
      const selected = state.routes[state.selectedRoute];
      const children = [];
      if (state.routes.length > 1 && session.alternativesSupported()) {
        // Alternatives: the provider offered them, so they are real. One
        // radio group; the selected route draws highlighted on the map.
        children.push(
          el(
            'div',
            {
              role: 'radiogroup',
              'aria-label': 'Route options',
              class: 'flex flex-col gap-2',
              dataset: { routeAlternatives: 'true' },
            },
            state.routes.map((route, i) =>
              routeSummary({
                route,
                modeLabel: session.modeLabel(),
                selected: i === state.selectedRoute,
                onSelect: () => session.selectRoute(i),
              }),
            ),
          ),
        );
      } else {
        children.push(routeSummary({ route: selected, modeLabel: session.modeLabel() }));
      }
      // One Start control for the whole result set, below the cards: the
      // alternative cards are radio buttons, and a button inside one would
      // nest interactive elements. Navigation always follows the selected
      // route as the provider returned it.
      const startNav = button(t('navigation.start'), {
        attrs: { dataset: { startNavigation: 'true' } },
        class: 'w-full py-3 text-base',
      });
      startNav.addEventListener('click', () => enterNavigation(selected, state));
      children.push(startNav);
      resultsSlot.replaceChildren(...children);
      return;
    }
    resultsSlot.replaceChildren();
  }

  // "My location" as the origin: the platform permission flow, exact
  // reasons, and never a fabricated coordinate.
  async function useCurrentLocation() {
    myLocationButton.disabled = true;
    const original = 'My location';
    myLocationButton.textContent = 'Locating…';
    try {
      const fix = await getCurrentLocation();
      const point = currentLocationPoint(fix);
      if (!point) {
        toast('We could not determine your location right now. Please try again.', true);
        return;
      }
      session.setOrigin(point);
      toast('Current location set as the origin.', false);
    } catch (err) {
      if (err instanceof LocationError) {
        // `reopening` is good news (the grant was made; the shell reopens
        // the frame), everything else is a real failure with honest copy.
        toast(err.message, err.reason !== 'reopening');
      } else {
        toast('We could not determine your location right now. Please try again.', true);
      }
    } finally {
      myLocationButton.disabled = false;
      myLocationButton.textContent = original;
    }
  }

  function toast(message, error) {
    const kit = window.unNative;
    if (kit && typeof kit.toast === 'function') {
      try {
        kit.toast(message, error ? { error: true } : {});
        return;
      } catch {
        /* fall through to a console note */
      }
    }
    console.info('[directions] ' + message);
  }
}

// ── Place → Directions hand-off ────────────────────────────────────────────
// Reads `?<name>=<encodeURIComponent(place name)>,<lat>,<lon>` from the
// fragment query (`/#/directions?to=...`, decoded by the router's hashParams).
// `to` pre-fills the destination (the Place hand-off), `from` the origin.
// Splitting on the last two commas keeps place names with commas intact when
// the whole value was URL-encoded. Returns a validated location point, or
// null for anything malformed — a malformed link pre-fills nothing rather
// than a guess.

function parsePointParam(name) {
  try {
    const raw = hashParams().get(name);
    if (!raw) return null;
    const last = raw.lastIndexOf(',');
    const prev = raw.lastIndexOf(',', last - 1);
    if (last < 0 || prev < 0) return null;
    const placeName = raw.slice(0, prev).trim();
    const lat = Number(raw.slice(prev + 1, last));
    const lon = Number(raw.slice(last + 1));
    return toLocationPoint({ id: 'link-' + name, name: placeName, lat, lon });
  } catch {
    return null;
  }
}

// ── the route map ──────────────────────────────────────────────────────────
//
// The existing Map abstraction renders the route: the screen never touches
// the renderer. The frame mirrors Home's map frame (same definite-height
// container, same overlay states, same attribution strip) minus the search
// panel, and adds only the route lifecycle: draw the returned routes,
// highlight the selected one, fit the camera to it, and clear obsolete
// geometry whenever the request changes.

function createRouteMap(mapConfig, getLatestState, trafficLegend) {
  const container = el('div', {
    class: 'relative h-[60vh] overflow-hidden rounded-card border border-line bg-surface-raised',
    dataset: { directionsMapFrame: 'true' },
  });
  const surface = el('div', {
    class: 'h-full w-full',
    dataset: { directionsMapCanvas: 'true' },
    role: 'img',
    'aria-label': 'Route map',
  });
  const overlay = el('div', {
    class: 'absolute inset-0 flex flex-col justify-center bg-surface-raised',
    dataset: { directionsMapOverlay: 'true' },
    'aria-live': 'polite',
  });
  container.append(surface, overlay);

  const attribution = el('p', {
    class: 'px-1 text-[11px] leading-relaxed text-muted [&_a]:text-brand [&_a]:underline',
    dataset: { directionsMapAttribution: 'true' },
  });
  const root = el('div', { class: 'flex flex-col gap-1', dataset: { directionsMap: 'true' } }, [
    container,
    attribution,
  ]);

  renderAttribution(attribution, (mapConfig && mapConfig.attribution) || DEFAULT_ATTRIBUTION);

  let service = null;
  let ready = false;
  let lastApplied = null; // identity key of the last routes+selection applied
  let navOverlayNode = null; // the navigation view's overlay, while one is live

  // ── traffic conditions (request #26) ────────────────────────────────────
  //
  // The route's traffic comes from the one source the app already has: the
  // community reports feed (Phase 6). One nearby query, centred so it covers
  // the drawn line, is filtered to the active jam-capable reports and cut
  // into per-segment pieces by services/traffic.js. The pieces attach to the
  // selected route as a red overlay and drive the legend. A failed query
  // shows no legend and no colours: an unavailable source is an honest
  // absence, never a guess.
  const trafficCache = new Map(); // coverage key -> { at, items }, 60 s
  let trafficState = null; // { key, state: 'loading'|'resolved'|'failed', jammed }
  let trafficGeneration = 0; // orphans in-flight fetches on route change

  function mount() {
    if (activeService) {
      activeService.destroy();
      activeService = null;
    }
    showOverlay(spinnerBlock('Loading map'));
    const mapService = createMapService(mapConfig, {
      onState: (state, err) => {
        if (activeService !== mapService) return;
        if (state === 'ready') onReady();
        else if (state === 'error') onFailure(err);
      },
    });
    activeService = mapService;
    service = mapService;
    mapService.mount(surface).catch((err) => {
      if (activeService === mapService) onFailure(err);
    });
  }

  function onReady() {
    ready = true;
    overlay.style.display = 'none';
    overlay.replaceChildren();
    apply(getLatestState());
  }

  function onFailure(err) {
    const kind = (err && err.kind) || MapErrorKind.STYLE_ERROR;
    if (kind === MapErrorKind.UNSUPPORTED_DEVICE) {
      showMessage(
        'This device cannot show the route map',
        'The map needs WebGL, which this browser or device does not provide. Distance and duration still work.',
      );
      return;
    }
    if (kind === MapErrorKind.NOT_CONFIGURED) {
      showMessage(
        'Map is not configured yet',
        'No map provider is connected, so the route cannot be drawn. Distance and duration still work.',
      );
      return;
    }
    showOverlay(
      errorState({
        title: 'We could not load the map',
        description: (err && err.message) || 'Check your connection and try again.',
        onRetry: () => mount(),
      }),
    );
  }

  function apply(state) {
    if (!ready || !service || !state) return;
    const key = applyKey(state);
    if (key === lastApplied) return;
    lastApplied = key;
    if (state.phase === 'routes') {
      const selected = state.routes[state.selectedRoute];
      // Traffic pieces for this exact route, when the derivation has already
      // answered for it; otherwise the plain line draws first and the red
      // pieces arrive when the reports query resolves.
      const jammed = trafficPiecesFor(key);
      service.setRoutes(
        state.routes.map((route, i) => {
          const item = {
            coordinates: route.geometry,
            selected: i === state.selectedRoute,
          };
          if (i === state.selectedRoute && jammed) item.traffic = { jammed };
          return item;
        }),
      );
      const bounds = geometryBounds(selected && selected.geometry);
      if (bounds) service.fitBounds(bounds);
      refreshTraffic(key, selected && selected.geometry);
    } else {
      // Form, loading or error: no route to draw. Obsolete geometry never
      // outlives its request — the traffic pieces and the legend with it.
      service.setRoutes(null);
      resetTraffic();
    }
  }

  // The identity key of a state's routes+selection, shared by apply()'s
  // dedupe and the traffic state.
  function applyKey(state) {
    return state.phase === 'routes'
      ? `routes:${state.selectedRoute}:${state.routes.length}:${state.routes[state.selectedRoute] ? state.routes[state.selectedRoute].geometry.length : 0}`
      : state.phase;
  }

  // The jammed pieces already derived for exactly this route key, or null.
  function trafficPiecesFor(key) {
    return trafficState &&
      trafficState.key === key &&
      trafficState.state === 'resolved' &&
      trafficState.jammed.length
      ? trafficState.jammed
      : null;
  }

  function resetTraffic() {
    trafficGeneration += 1; // orphan any in-flight fetch
    trafficState = null;
    renderTrafficLegend();
  }

  // Ask the community feed what the reports say about this route. Resolves
  // into jammed pieces + legend; never throws into the caller.
  async function refreshTraffic(key, geometry) {
    if (!geometry || geometry.length < 2) return;
    if (
      trafficState &&
      trafficState.key === key &&
      (trafficState.state === 'resolved' || trafficState.state === 'failed')
    ) {
      // Already answered (positively or negatively) for this exact route.
      renderTrafficLegend();
      return;
    }
    const generation = ++trafficGeneration;
    trafficState = { key, state: 'loading', jammed: [] };
    renderTrafficLegend();
    try {
      const coverage = coverageForGeometry(geometry);
      const cacheKey = coverage
        ? `${coverage.near.lat.toFixed(3)},${coverage.near.lng.toFixed(3)},${coverage.radiusKm}`
        : null;
      let cached = cacheKey ? trafficCache.get(cacheKey) : null;
      if (cached && Date.now() - cached.at > TRAFFIC_CACHE_MS) cached = null;
      if (!cached && coverage) {
        const feed = await listReports('nearby', {
          near: coverage.near,
          radiusKm: Math.min(coverage.radiusKm, NEARBY_RADIUS_CAP_KM),
        });
        cached = { at: Date.now(), items: activeJamReports((feed && feed.items) || []) };
        trafficCache.set(cacheKey, cached);
      }
      if (generation !== trafficGeneration) return;
      const { jammed } = routeConditions(geometry, cached ? cached.items : []);
      trafficState = { key, state: 'resolved', jammed };
    } catch (err) {
      if (generation !== trafficGeneration) return;
      console.warn('[directions] traffic check failed: ' + (err && err.message));
      trafficState = { key, state: 'failed', jammed: [] };
    }
    renderTrafficLegend();
    applyTrafficPieces();
  }

  // Re-draw the routes with the traffic pieces attached, bypassing apply()'s
  // dedupe: the route itself has not changed, only its overlay has.
  function applyTrafficPieces() {
    if (!ready || !service || !trafficState) return;
    const state = getLatestState();
    if (!state || state.phase !== 'routes') return;
    const jammed = trafficPiecesFor(applyKey(state));
    if (!jammed) return;
    service.setRoutes(
      state.routes.map((route, i) => {
        const item = {
          coordinates: route.geometry,
          selected: i === state.selectedRoute,
        };
        if (i === state.selectedRoute) item.traffic = { jammed };
        return item;
      }),
    );
  }

  function renderTrafficLegend() {
    if (!trafficLegend) return;
    if (!trafficState || trafficState.state !== 'resolved') {
      trafficLegend.style.display = 'none';
      trafficLegend.replaceChildren();
      return;
    }
    trafficLegend.style.display = '';
    trafficLegend.replaceChildren(
      el('span', { class: 'font-medium text-ink', text: t('traffic.legendTitle') }),
      legendSwatch(TRAFFIC_JAM_COLOR, t('traffic.legendJam')),
      legendSwatch(TRAFFIC_CLEAR_COLOR, t('traffic.legendFlowing')),
      el('span', { text: t('traffic.legendSource') }),
    );
  }

  function legendSwatch(color, label) {
    return el('span', { class: 'inline-flex items-center gap-1.5' }, [
      el('span', {
        class: 'inline-block h-2.5 w-6 rounded-full',
        style: 'background: ' + color,
      }),
      el('span', { text: label }),
    ]);
  }

  function showOverlay(node) {
    overlay.style.display = '';
    overlay.replaceChildren(node);
  }

  function showMessage(title, body) {
    showOverlay(
      el('div', { class: 'flex h-full flex-col items-center justify-center gap-2 p-6 text-center' }, [
        el('p', { class: 'text-base font-semibold text-ink', text: title }),
        el('p', { class: 'max-w-sm text-sm text-muted leading-relaxed', text: body }),
      ]),
    );
  }

  function spinnerBlock(label) {
    return el('div', { class: 'flex flex-col items-center gap-3', dataset: { mapLoading: 'true' } }, [
      spinner(),
      el('p', { class: 'text-sm text-muted', text: label }),
    ]);
  }

  mount();

  return {
    root,
    // Always read through the getter: the raw session snapshot sync() receives
    // carries no `phase` (it is derived in the core, not stored), and the map
    // key depends on it.
    update() {
      apply(getLatestState());
    },
    // Navigation (Phase 8) mounts its overlay inside this same frame and
    // drives the same service directly, so guidance shares the one WebGL
    // context instead of building a second map.
    mountOverlay(node) {
      navOverlayNode = node;
      container.appendChild(node);
    },
    clearOverlay() {
      if (navOverlayNode && navOverlayNode.parentNode === container) {
        navOverlayNode.remove();
      }
      navOverlayNode = null;
    },
    // Run one operation against the live service now (throttling is the
    // navigation view's job). No-op before the map is ready.
    apply(fn) {
      if (ready && service && typeof fn === 'function') fn(service);
    },
    // Re-run the standard planning apply from scratch: after a navigation
    // session trimmed the drawn line, this restores the full selected route.
    refresh() {
      lastApplied = null;
      apply(getLatestState());
    },
    destroy() {
      trafficGeneration += 1; // orphan any in-flight traffic fetch
      if (service) service.destroy();
      service = null;
      ready = false;
    },
  };
}

// ── attribution ────────────────────────────────────────────────────────────

function renderAttribution(node, text) {
  if (!node) return;
  const parts = attributionParts(text);
  const children = [el('span', { text: 'Route data: ' })];
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
