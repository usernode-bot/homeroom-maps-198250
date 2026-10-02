// Trips — the travel & day-by-day trip planner (Phase 10).
//
// Hash-param driven like the Community screen:
//   #/trips              the viewer's trip list
//   #/trips?trip=<id>    one trip's detail (days, itinerary, map, legs)
//   #/trips?demo=1       the staging demo trip (staging only, read-only)
//
// The screen is a pure function of what the API returns. It reuses the
// existing Places, routing, navigation, map and i18n contracts rather than
// reimplementing them, and shows an honest unavailable state wherever a
// contract cannot help: no place provider means "Opening hours unavailable",
// no route geometry means no drawn leg, and the add-place sheet's "Saved
// places" source is static unavailable copy (Saved Places is not built).
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { card } from '../components/card.js';
import { icon } from '../components/icons.js';
import { loading, spinner } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { createSearchBar } from '../components/search/search-bar.js';
import { tripCard, daySection } from '../components/trips/parts.js';
import {
  fetchTrips,
  fetchTrip,
  createTrip,
  updateTrip,
  deleteTrip,
  addItem,
  removeItem,
  moveItem,
} from '../services/trips.js';
import {
  dayLabel,
  dayRange,
  destinationBody,
  legPairs,
  legRequest,
  legLine,
  legErrorKind,
  selectableModes,
  unavailableModes,
} from '../services/trips-core.js';
import { fetchDirections } from '../services/routing.js';
import { fetchSearch, DEBOUNCE_MS, MIN_QUERY_LENGTH } from '../services/search.js';
import { placeFromSearchResult } from '../services/places-model.js';
import { fetchPlace } from '../services/places.js';
import { createPlaceDetailSession } from '../services/place-detail.js';
import { createPlaceDetailView } from './place-detail.js';
import { geometryBounds } from '../services/routing-core.js';
import { createMapService, isConfigured as mapIsConfigured } from '../services/map.js';
import { getState } from '../state.js';
import { hasToken } from '../auth.js';
import { t, getLocale } from '../i18n/index.js';
import * as router from '../router.js';

function isAbort(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export async function render(ctx) {
  const params = router.hashParams();
  const demo = params.get('demo') === '1';
  const deepTrip = params.get('trip');

  if (!hasToken()) {
    ctx.content.replaceChildren(
      el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.trips') }),
      emptyState({
        title: t('trips.signedOutTitle'),
        description: t('trips.signedOutBody'),
      }),
    );
    return;
  }

  if (demo) {
    // The demo link opens the seeded, read-only trip straight away. The id in
    // the link is only a hint: the demo trip is whichever row the staging seed
    // created, so a stale or absent id still lands on it.
    await renderDetail(ctx, { id: deepTrip, readOnly: true, demo: true });
    return;
  }
  if (deepTrip && /^\d+$/.test(deepTrip)) {
    await renderDetail(ctx, { id: deepTrip, readOnly: false, demo: false });
    return;
  }

  await renderList(ctx);
}

// ── list ───────────────────────────────────────────────────────────────────

async function renderList(ctx) {
  const host = el('div', { class: 'flex flex-col gap-3', dataset: { tripsHost: 'true' } });
  const newButton = button(t('trips.new'), { attrs: { dataset: { newTrip: 'true' } } });
  newButton.addEventListener('click', () => openForm({ onSaved: (saved) => openDetail(saved.id) }));

  ctx.content.replaceChildren(
    el('div', { class: 'flex items-center justify-between gap-3' }, [
      el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.trips') }),
      newButton,
    ]),
    el('p', { class: 'text-sm text-muted leading-relaxed', text: t('trips.intro') }),
    host,
  );

  async function load() {
    host.dataset.tripsState = 'loading';
    host.replaceChildren(loading({ label: t('trips.loading') }));
    try {
      const { items } = await fetchTrips();
      if (!items.length) {
        host.dataset.tripsState = 'empty';
        host.replaceChildren(
          emptyState({
            title: t('trips.emptyTitle'),
            description: t('trips.emptyBody'),
            action: button(t('trips.new'), { variant: 'secondary', onClick: () => openForm({ onSaved: (s) => openDetail(s.id) }) }),
          }),
        );
        return;
      }
      host.dataset.tripsState = 'ready';
      host.replaceChildren(
        el(
          'div',
          { class: 'flex flex-col gap-3', dataset: { tripList: 'true' } },
          items.map((trip) => tripCard(trip, { onOpen: (x) => openDetail(x.id) })),
        ),
      );
    } catch (err) {
      host.dataset.tripsState = 'error';
      host.replaceChildren(
        errorState({ title: t('trips.errorTitle'), description: err.message, onRetry: load }),
      );
    }
  }

  function openDetail(id) {
    router.replaceHashParams({ trip: id });
    renderDetail(ctx, { id, readOnly: false, demo: false });
  }

  await load();
}

// ── create / edit form ──────────────────────────────────────────────────────

// A small overlay form for creating or editing a trip. `trip` present = edit.
function openForm({ trip = null, onSaved, onCancel } = {}) {
  const overlay = el('div', {
    class: 'fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-3 sm:items-center',
    dataset: { tripForm: 'true' },
  });
  const fields = {};
  const errorHost = el('div', { class: 'text-xs text-danger', dataset: { tripFormError: 'true' } });
  const isEdit = Boolean(trip);

  const nameInput = inputEl({ value: trip ? trip.name : '', placeholder: t('trips.form.name') });

  // Destination reuses the existing Phase 2/3 search + place-selection
  // contract (the same createSearchBar + fetchSearch + placeFromSearchResult
  // pair the add-place sheet uses). Only a real search result the user picks
  // is stored, and only the coordinates that result carries: typed text is
  // never geocoded and no coordinates are invented. Destination stays
  // optional.
  const destination = { current: null };
  if (trip && trip.destination && trip.destination.name) {
    destination.current = {
      name: trip.destination.name,
      coordinates:
        trip.destination.lat != null && trip.destination.lng != null
          ? { lat: trip.destination.lat, lon: trip.destination.lng }
          : null,
    };
  }
  const destinationSearch = createDestinationPicker(destination);

  const startInput = dateEl({ value: trip ? trip.startDate : todayIso() });
  const endInput = dateEl({ value: trip ? trip.endDate : addDaysIso(todayIso(), 1) });
  endInput.addEventListener('change', () => {
    if (startInput.value && endInput.value && endInput.value < startInput.value) endInput.value = startInput.value;
  });

  const save = button(isEdit ? t('trips.form.save') : t('trips.form.create'), {
    attrs: { dataset: { tripFormSave: 'true' } },
  });
  const cancel = button(t('common.cancel'), { variant: 'ghost', onClick: () => close() });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  save.addEventListener('click', async () => {
    const body = {
      name: nameInput.value,
      destination: destinationBody(destination.current),
      startDate: startInput.value,
      endDate: endInput.value,
    };
    save.disabled = true;
    errorHost.textContent = '';
    try {
      const saved = isEdit ? await updateTrip(trip.id, body) : await createTrip(body);
      close();
      if (onSaved) onSaved(saved);
    } catch (err) {
      save.disabled = false;
      const fieldMsgs = err && err.fields ? Object.values(err.fields) : [];
      errorHost.textContent = fieldMsgs.length ? fieldMsgs.join(' ') : err.message;
    }
  });

  function close() {
    overlay.remove();
    if (onCancel) onCancel();
  }

  overlay.appendChild(
    card(
      [
        el('p', { class: 'text-base font-semibold text-ink', text: isEdit ? t('trips.form.editTitle') : t('trips.form.title') }),
        el('div', { class: 'mt-3 flex flex-col gap-3' }, [
          labelled(t('trips.form.name'), nameInput),
          destinationSearch.root,
          el('p', { class: 'text-xs text-muted', text: t('trips.form.destinationHint') }),
          el('div', { class: 'flex gap-3' }, [
            el('div', { class: 'flex flex-1 flex-col gap-1' }, [labelled(t('trips.form.start'), startInput)]),
            el('div', { class: 'flex flex-1 flex-col gap-1' }, [labelled(t('trips.form.end'), endInput)]),
          ]),
        ]),
        errorHost,
        el('div', { class: 'mt-4 flex justify-end gap-2' }, [cancel, save]),
      ],
      { class: 'w-full max-w-md' },
    ),
  );

  document.body.appendChild(overlay);
  nameInput.focus();
  return { close };
}

// The trip form's destination field: the same search-then-pick flow the
// add-place sheet uses, so a destination is always a real search result (with
// only the coordinates that result carries), never typed text turned into a
// place. `picked` is a { current } box the form reads at save time; editing a
// trip prefills the stored destination's name and lets the user re-pick.
function createDestinationPicker(picked) {
  const input = el('input', {
    type: 'search',
    dataset: { tripDestination: 'true' },
    placeholder: t('trips.form.destinationPick'),
    'aria-label': t('trips.form.destinationPick'),
    class:
      'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
  });

  const results = el('div', {
    class: 'flex max-h-56 flex-col gap-1.5 overflow-y-auto',
    dataset: { tripDestinationResults: 'true' },
  });
  const selected = el('div', { class: 'flex items-center gap-2 text-xs text-muted', dataset: { tripDestinationSelected: 'true' } });
  const root = el('div', { class: 'relative flex flex-col gap-1.5' }, [input, results, selected]);

  let controller = null;
  let debounceTimer = null;
  let generation = 0;

  function syncSelected() {
    input.value = picked.current ? picked.current.name : '';
    const children = [
      el('span', {
        text: picked.current
          ? t('trips.form.destinationSelected', { name: picked.current.name })
          : t('trips.form.destinationNone'),
      }),
    ];
    if (picked.current) {
      children.push(
        el('button', {
          type: 'button',
          class:
            'rounded-pill px-2 py-0.5 text-xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          dataset: { tripDestinationClear: 'true' },
          text: t('trips.form.destinationClear'),
          onClick: () => {
            picked.current = null;
            results.replaceChildren();
            syncSelected();
          },
        }),
      );
    }
    selected.replaceChildren(...children);
  }

  syncSelected();

  function cancelPending() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (controller) controller.abort();
    controller = null;
  }

  function schedule(value) {
    cancelPending();
    const q = value.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      results.replaceChildren();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      run(q);
    }, DEBOUNCE_MS);
  }

  async function run(q) {
    if (q.length < MIN_QUERY_LENGTH) return;
    cancelPending();
    generation += 1;
    const gen = generation;
    controller = new AbortController();
    results.replaceChildren(el('div', { class: 'flex items-center justify-center py-2' }, [spinner()]));
    try {
      const rows = await fetchSearch(q, { signal: controller.signal });
      if (gen !== generation) return;
      const places = rows.map((r) => placeFromSearchResult(r)).filter(Boolean);
      if (!places.length) {
        results.replaceChildren(
          el('p', { class: 'py-2 text-center text-xs text-muted', text: t('trips.form.destinationNoResults') }),
        );
        return;
      }
      results.replaceChildren(...places.map(destinationRow));
    } catch (err) {
      if (isAbort(err) || gen !== generation) return;
      results.replaceChildren(
        el('p', { class: 'py-2 text-center text-xs text-danger', text: err.message }),
      );
    }
  }

  function destinationRow(place) {
    return el('button', {
      type: 'button',
      class:
        'flex flex-col rounded-lg border border-line px-3 py-2 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      dataset: { tripDestinationResult: place.id },
      onClick: () => {
        picked.current = {
          name: place.name,
          coordinates: place.coordinates
            ? { lat: place.coordinates.lat, lon: place.coordinates.lon }
            : null,
        };
        cancelPending();
        results.replaceChildren();
        syncSelected();
      },
    }, [
      el('span', { class: 'truncate text-sm text-ink', text: place.name }),
      place.address || place.category
        ? el('span', { class: 'truncate text-xs text-muted', text: place.address || place.category })
        : null,
    ]);
  }

  input.addEventListener('input', () => schedule(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run(input.value.trim());
    }
  });

  return { root, input };
}

function inputEl({ value = '', placeholder = '' } = {}) {
  const input = el('input', {
    type: 'text',
    value,
    placeholder,
    class:
      'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
  });
  return input;
}

function dateEl({ value = '' } = {}) {
  return el('input', {
    type: 'date',
    value,
    class:
      'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
  });
}

function labelled(label, input) {
  return el('label', { class: 'flex flex-col gap-1' }, [
    el('span', { class: 'text-xs font-medium text-muted', text: label }),
    input,
  ]);
}

// ── detail ──────────────────────────────────────────────────────────────────

async function renderDetail(ctx, { id, readOnly = false, demo = false }) {
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.trips') }),
    loading({ label: t('trips.loading') }),
  );

  let trip = null;
  try {
    if (demo) {
      const { items } = await fetchTrips({ demo: true });
      trip = items.find((x) => x.id === id) || items[0] || null;
      if (!trip) throw new Error(t('trips.errorTitle'));
    } else {
      trip = await fetchTrip(id);
    }
  } catch (err) {
    ctx.content.replaceChildren(
      el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.trips') }),
      backButton(ctx),
      errorState({ title: t('trips.errorTitle'), description: err.message, onRetry: () => renderDetail(ctx, { id, readOnly, demo }) }),
    );
    return;
  }

  const mapConfig = (getState().config && getState().config.map) || null;
  const modes = selectableModes(getState().config);
  const activeMode = modes[0] || null;

  // Per-mount leg cache, keyed origin|destination|mode. Nothing is polled.
  const legCache = new Map();
  const legSeq = { running: false };
  const canRoute = modes.length > 0;

  const detail = el('div', { class: 'flex flex-col gap-4', dataset: { tripDetail: id } });
  const daysHost = el('div', { class: 'flex flex-col gap-4', dataset: { tripDays: 'true' } });
  const mapHost = el('div', { class: 'flex flex-col gap-2', dataset: { tripMapHost: 'true' } });
  const legsButton = button(t('trips.leg.show'), { variant: 'secondary', attrs: { dataset: { showLegs: 'true' } } });
  legsButton.disabled = !canRoute;
  legsButton.addEventListener('click', () => loadLegs());

  const header = el('div', { class: 'flex flex-col gap-2' }, [
    el('div', { class: 'flex items-start justify-between gap-3' }, [
      el('div', { class: 'flex min-w-0 flex-col' }, [
        el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: trip.name }),
        el('p', { class: 'text-sm text-muted', text: tripRangeLabel(trip) }),
        trip.destination && trip.destination.name
          ? el('p', { class: 'mt-1 flex items-center gap-1 text-sm text-muted' }, [
              icon('pin', { class: 'h-4 w-4 shrink-0' }),
              el('span', { text: trip.destination.name }),
            ])
          : null,
      ]),
      readOnly || demo ? null : el('div', { class: 'flex shrink-0 gap-2' }, [
        button(t('trips.edit'), {
          variant: 'ghost',
          class: 'px-3 py-1.5 text-xs',
          attrs: { dataset: { editTrip: 'true' } },
          onClick: () => openForm({ trip, onSaved: (saved) => renderDetail(ctx, { id: saved.id, readOnly: false, demo: false }) }),
        }),
        button(t('trips.delete'), {
          variant: 'ghost',
          class: 'px-3 py-1.5 text-xs',
          attrs: { dataset: { deleteTrip: 'true' } },
          onClick: () => confirmDelete(),
        }),
      ]),
    ]),
  ]);

  const modeNote = el('p', { class: 'text-xs text-muted', dataset: { tripModeNote: 'true' } });
  if (canRoute) {
    const unavailable = unavailableModes(getState().config).map((m) => t('trips.mode.' + m));
    modeNote.textContent = unavailable.length
      ? t('trips.mode.served', { mode: t('trips.mode.' + activeMode), others: unavailable.join(', ') })
      : t('trips.mode.servedOnly', { mode: t('trips.mode.' + activeMode) });
  } else {
    modeNote.textContent = t('trips.mode.none');
  }
  legsButton.textContent = t('trips.leg.show');

  detail.replaceChildren(header, backButton(ctx), legSummaryHost(), mapHost, daysHost, demoNote());
  ctx.content.replaceChildren(detail);

  // The map: the existing service + adapter, drawing route lines via the
  // existing setRoutes/fitBounds contract. Unavailable states reuse the map's
  // own rendering (the frame simply stays empty when nothing can be drawn).
  let service = null;
  async function mountMap() {
    if (!mapIsConfigured(mapConfig)) return;
    try {
      const frame = el('div', {
        class: 'h-64 w-full overflow-hidden rounded-card border border-line bg-surface-raised',
        dataset: { tripMap: 'true' },
      });
      mapHost.replaceChildren(frame);
      service = createMapService(mapConfig, {});
      await service.mount(frame);
      drawMap();
    } catch {
      // The map's own unavailable state: leave the frame empty rather than
      // claiming a map that did not render.
      mapHost.replaceChildren(
        el('p', {
          class: 'rounded-card border border-dashed border-line bg-surface/60 px-4 py-3 text-center text-xs text-muted',
          text: t('trips.mapUnavailable'),
        }),
      );
      service = null;
    }
  }

  function drawMap() {
    if (!service) return;
    const lines = [];
    const markers = [];
    const allCoords = [];
    let order = 0;
    for (const day of trip.days) {
      for (const item of day.items) {
        order += 1;
        const c = item.place && item.place.coordinates;
        if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
          allCoords.push([Number(c.lng), Number(c.lat)]);
          markers.push({ lng: Number(c.lng), lat: Number(c.lat), label: String(order), selected: false });
        }
      }
      for (const pair of legPairs(day.items)) {
        const entry = legCache.get(legKey(pair, activeMode));
        const route = entry && entry.routes && entry.routes[0];
        if (route && Array.isArray(route.geometry) && route.geometry.length) {
          lines.push({ coordinates: route.geometry, selected: true });
          allCoords.push(...route.geometry);
        }
      }
    }
    service.setRoutes(lines.length ? lines : null);
    if (typeof service.setMarkers === 'function') service.setMarkers(markers);
    const bounds = geometryBounds(allCoords);
    if (bounds) service.fitBounds(bounds, { padding: 40 });
  }

  // ── legs ──────────────────────────────────────────────────────────────────

  function legKey(pair, mode) {
    return pair.origin.lat + ',' + pair.origin.lng + '|' + pair.destination.lat + ',' + pair.destination.lng + '|' + (mode || '');
  }

  // Sequential, one request per pair, cached per mount. A failed leg is
  // cached as an error so a re-render never re-fires it.
  async function loadLegs() {
    if (!canRoute || legSeq.running) return;
    legSeq.running = true;
    legsButton.disabled = true;
    legsButton.textContent = t('trips.leg.loading');
    const pairs = [];
    for (const day of trip.days) pairs.push(...legPairs(day.items));
    for (const pair of pairs) {
      const key = legKey(pair, activeMode);
      if (legCache.has(key)) continue;
      try {
        const routes = await fetchDirections(legRequest(pair, activeMode));
        legCache.set(key, { routes: Array.isArray(routes) ? routes : [] });
      } catch (err) {
        legCache.set(key, { error: legErrorKind(err), kind: legErrorKind(err), message: err.message });
      }
    }
    legSeq.running = false;
    legsButton.disabled = false;
    legsButton.textContent = t('trips.leg.refresh');
    renderDays();
    drawMap();
  }

  function legFor(fromItem, toItem) {
    const pair = legPairs([fromItem, toItem])[0];
    if (!pair) return null; // a stop without coordinates: the leg is omitted
    const entry = legCache.get(legKey(pair, activeMode));
    if (!entry) {
      return { state: 'unavailable', text: t('trips.leg.notShown'), onShow: canRoute ? () => loadLegs() : null };
    }
    if (entry.error) {
      return { state: 'error', text: t('trips.leg.unavailable') };
    }
    const route = entry.routes[0];
    if (!route) return { state: 'error', text: t('trips.leg.unavailable') };
    return {
      state: 'ready',
      text: legLine(route.distance, route.duration, {
        locale: getLocale(),
        labels: { distance: t('trips.leg.distanceUnavailable'), duration: t('trips.leg.durationUnavailable') },
      }),
    };
  }

  // ── day + item rendering ─────────────────────────────────────────────────

  function renderDays() {
    daysHost.replaceChildren(
      ...trip.days.map((day, index) => {
        const label = dayLabel(day.date, { locale: getLocale() });
        const withLabel = { ...day, label };
        const dayOptions = trip.days.map((d, di) => ({
          value: d.id,
          selected: d.id === day.id,
          label: t('trips.day.heading', { day: di + 1 }),
        }));
        return daySection(withLabel, {
          index,
          legFor,
          onAddPlace: (d) => openAddPlace(d),
          actions: (item, i) => ({
            viewPlace: (it) => openPlace(it),
            directions: (it) => openDirections(it),
            navigate: (it) => openNavigate(it),
            moveUp: (it) => move(it, day, i - 1),
            moveDown: (it) => move(it, day, i + 1),
            remove: (it) => removeStop(it),
            moveToDay: (it, dayId) => moveToDay(it, dayId),
            canMoveUp: i > 0,
            canMoveDown: i < day.items.length - 1,
            dayOptions,
          }),
        });
      }),
    );
  }

  async function move(item, day, index) {
    if (readOnly) return;
    try {
      trip = await moveItem(id, item.id, { dayId: day.id, index });
      renderDays();
      drawMap();
    } catch (err) {
      alertError(err);
    }
  }

  async function moveToDay(item, dayId) {
    if (readOnly) return;
    try {
      trip = await moveItem(id, item.id, { dayId, index: indexOfDay(dayId) });
      renderDays();
      drawMap();
    } catch (err) {
      alertError(err);
    }
  }

  function indexOfDay(dayId) {
    const day = trip.days.find((d) => d.id === dayId);
    return day ? day.items.length : 0;
  }

  async function removeStop(item) {
    if (readOnly) return;
    if (!window.confirm(t('trips.item.confirmRemove'))) return;
    try {
      trip = await removeItem(id, item.id);
      renderDays();
      drawMap();
    } catch (err) {
      alertError(err);
    }
  }

  function alertError(err) {
    ctx.content.prepend(
      el('p', {
        class: 'rounded-card border border-line bg-surface px-4 py-3 text-sm text-danger',
        role: 'alert',
        text: (err && err.message) || t('trips.actionFailed'),
      }),
    );
  }

  async function confirmDelete() {
    if (!window.confirm(t('trips.confirmDelete', { name: trip.name }))) return;
    try {
      await deleteTrip(id);
      router.replaceHashParams({});
      renderList(ctx);
    } catch (err) {
      alertError(err);
    }
  }

  // ── actions: view place / directions / navigate ────────────────────────────

  // Reuses the Place Detail screen unchanged: build the session from the
  // item's stored summary snapshot, enrich through fetchPlace (which honestly
  // answers not_configured today), and render the existing view.
  function openPlace(item) {
    const place = placeFromItem(item);
    if (!place) return;
    const session = createPlaceDetailSession({ place, fetchDetails: (pid) => fetchPlace(pid) });
    const view = createPlaceDetailView({ session, onBack: () => { ctx.content.replaceChildren(...savedContent); } });
    const savedContent = detailNodes();
    session.subscribe(() => view.update(session.getState()));
    ctx.content.replaceChildren(view.root);
    session.start();
  }

  // Routes through the existing Directions deep link; the place's own name
  // and real coordinates are carried, nothing is invented.
  function openDirections(item) {
    const c = coordinatesOfItem(item);
    if (!c) return;
    const place = item.place || {};
    router.navigate('directions');
    window.location.hash = '#/directions?to=' + encodePointParam(place.name || item.placeId, c);
  }

  // The existing Navigation contract is entered via the Directions deep link;
  // its own "Navigation needs a route" state is reused when no route exists.
  function openNavigate(item) {
    const c = coordinatesOfItem(item);
    if (!c) return;
    const place = item.place || {};
    window.location.hash = '#/directions?to=' + encodePointParam(place.name || item.placeId, c) + '&navigate=1';
  }

  // ── add place sheet ───────────────────────────────────────────────────────

  function openAddPlace(day) {
    if (readOnly) return;
    let controller = null;
    let debounceTimer = null;
    let generation = 0;
    let source = 'search'; // search | saved

    const overlay = el('div', {
      class: 'fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-3 sm:items-center',
      dataset: { addPlaceSheet: 'true' },
    });
    const resultsHost = el('div', { class: 'flex min-h-24 flex-col gap-1.5', dataset: { addPlaceResults: 'true' } });
    const errorHost = el('div', { class: 'text-xs text-danger' });

    const bar = createSearchBar({
      onInput: (value) => {
        bar.update({ query: value, open: false, highlighted: -1 });
        schedule(value);
      },
      onFocus: () => {},
      onBlur: () => {},
      onKeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          run(bar.input.value.trim());
        }
      },
      onClear: () => {
        bar.update({ query: '', open: false, highlighted: -1 });
        cancelPending();
        renderSourcePanel();
      },
    });

    // The two place sources. "Saved places" is honest static copy: the Saved
    // Places feature is not built, so no list is offered and no request made.
    const sourceTabs = el('div', { class: 'flex gap-1 rounded-pill bg-surface-raised p-1' }, [
      sourceTab('trips.addPlace.sourceSearch', 'search'),
      sourceTab('trips.addPlace.sourceSaved', 'saved'),
    ]);

    function sourceTab(key, value) {
      const active = source === value;
      return el('button', {
        type: 'button',
        class: [
          'flex-1 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          active ? 'bg-surface text-ink' : 'text-muted hover:text-ink',
        ].join(' '),
        'aria-pressed': active ? 'true' : 'false',
        dataset: { addPlaceSource: value },
        text: t(key),
        onClick: () => selectSource(value),
      });
    }

    function selectSource(value) {
      source = value;
      cancelPending();
      sourceTabs.replaceChildren(
        sourceTab('trips.addPlace.sourceSearch', 'search'),
        sourceTab('trips.addPlace.sourceSaved', 'saved'),
      );
      errorHost.textContent = '';
      renderSourcePanel();
    }

    function cancelPending() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (controller) controller.abort();
      controller = null;
    }

    function renderSourcePanel() {
      if (source === 'saved') {
        resultsHost.replaceChildren(
          el('p', {
            class: 'rounded-card border border-dashed border-line bg-surface/60 px-4 py-4 text-center text-sm text-muted',
            dataset: { savedUnavailable: 'true' },
            text: t('trips.addPlace.savedUnavailable'),
          }),
        );
        return;
      }
      resultsHost.replaceChildren(
        el('p', { class: 'py-4 text-center text-sm text-muted', text: t('trips.addPlace.hint') }),
      );
    }

    function schedule(value) {
      cancelPending();
      const q = value.trim();
      if (q.length < MIN_QUERY_LENGTH) {
        renderSourcePanel();
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        run(q);
      }, DEBOUNCE_MS);
    }

    async function run(q) {
      if (source !== 'search' || q.length < MIN_QUERY_LENGTH) return;
      cancelPending();
      generation += 1;
      const gen = generation;
      controller = new AbortController();
      resultsHost.replaceChildren(
        el('div', { class: 'flex items-center justify-center py-4' }, [spinner()]),
      );
      try {
        const results = await fetchSearch(q, { signal: controller.signal });
        if (gen !== generation) return;
        const places = results.map((r) => placeFromSearchResult(r)).filter(Boolean);
        if (!places.length) {
          resultsHost.replaceChildren(
            el('p', { class: 'py-4 text-center text-sm text-muted', text: t('trips.addPlace.none') }),
          );
          return;
        }
        resultsHost.replaceChildren(
          ...places.map((place) => addPlaceRow(place, day)),
        );
      } catch (err) {
        if (isAbort(err) || gen !== generation) return;
        resultsHost.replaceChildren(
          el('p', { class: 'py-4 text-center text-sm text-danger', text: err.message }),
        );
      }
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    function close() {
      cancelPending();
      overlay.remove();
    }

    overlay.appendChild(
      card(
        [
          el('p', { class: 'text-base font-semibold text-ink', text: t('trips.addPlace.title') }),
          el('p', { class: 'text-xs text-muted' , text: t('trips.addPlace.dayHint', { day: dayLabel(day.date, { locale: getLocale() }) }) }),
          el('div', { class: 'mt-3 flex flex-col gap-3' }, [sourceTabs, bar.root, errorHost, resultsHost]),
          el('div', { class: 'mt-4 flex justify-end' }, [
            button(t('common.cancel'), { variant: 'ghost', onClick: () => close() }),
          ]),
        ],
        { class: 'w-full max-w-md' },
      ),
    );

    document.body.appendChild(overlay);
    renderSourcePanel();
    bar.input.focus();
  }

  function addPlaceRow(place, day) {
    return el('div', { class: 'flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2' }, [
      el('div', { class: 'flex min-w-0 flex-col' }, [
        el('p', { class: 'truncate text-sm font-medium text-ink', text: place.name }),
        el('p', { class: 'truncate text-xs text-muted', text: place.address || place.category || '' }),
      ]),
      button(t('trips.addPlace.add'), {
        variant: 'secondary',
        class: 'shrink-0 px-3 py-1.5 text-xs',
        attrs: { dataset: { addPlaceConfirm: place.id } },
        onClick: async (e) => {
          e.target.disabled = true;
          try {
            trip = await addItem(id, day.id, {
              placeId: place.id,
              placeSnapshot: snapshotOfPlace(place),
            });
            // Close the sheet (its overlay is the last child of body).
            document.querySelector('[data-add-place-sheet]')?.remove();
            renderDays();
            drawMap();
          } catch (err) {
            e.target.disabled = false;
            const fieldMsgs = err && err.fields ? Object.values(err.fields) : [];
            errorHost.textContent = fieldMsgs.length ? fieldMsgs.join(' ') : err.message;
          }
        },
      }),
    ]);
  }

  // ── content helpers ───────────────────────────────────────────────────────

  function backButton(context) {
    const b = el(
      'button',
      {
        type: 'button',
        class:
          'self-start rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        dataset: { tripBack: 'true' },
        text: t('trips.back'),
        onClick: () => {
          router.replaceHashParams({});
          renderList(context);
        },
      },
    );
    return b;
  }

  function legSummaryHost() {
    return el('div', { class: 'flex flex-wrap items-center gap-3', dataset: { tripLegsHost: 'true' } }, [legsButton, modeNote]);
  }

  function demoNote() {
    return demo
      ? el('p', {
          class: 'rounded-card border border-dashed border-line bg-surface/60 px-4 py-3 text-xs text-muted',
          dataset: { tripDemoNote: 'true' },
          text: t('trips.demoNote'),
        })
      : el('span');
  }

  function detailNodes() {
    return [detail];
  }

  // ── first paint ────────────────────────────────────────────────────────────

  renderDays();
  await mountMap();
  // Travel times are on demand only: no directions request is made just
  // because the detail page was opened. The user taps "Show travel times"
  // (or "Refresh travel times") to fetch them.
}

function tripRangeLabel(trip) {
  if (trip.startDate === trip.endDate) return dayLabel(trip.startDate, { locale: getLocale() }) || trip.startDate;
  const from = dayLabel(trip.startDate, { locale: getLocale() }) || trip.startDate;
  const to = dayLabel(trip.endDate, { locale: getLocale() }) || trip.endDate;
  return from + ' – ' + to;
}

function coordinatesOfItem(item) {
  const c = item && item.place && item.place.coordinates;
  if (!c) return null;
  const lat = Number(c.lat);
  const lng = Number(c.lng != null ? c.lng : c.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// The item's stored display-only summary, shaped as a Place for the existing
// detail view. No provider depth is claimed: hours/rating/photos stay absent
// and the view renders its own honest unavailable states.
function placeFromItem(item) {
  const snap = item && item.place;
  if (!snap || !snap.name) return null;
  const c = snap.coordinates;
  return {
    id: item.placeId,
    name: snap.name,
    localizedNames: null,
    category: snap.category || null,
    subcategory: snap.subcategory || null,
    coordinates:
      c && Number.isFinite(Number(c.lat)) ? { lat: Number(c.lat), lon: Number(c.lng) } : null,
    address: snap.address || null,
    country: null,
    phone: null,
    website: null,
    openingHours: null,
    rating: null,
    photos: [],
    businessStatus: null,
    verificationStatus: null,
    dataSource: 'search',
  };
}

function snapshotOfPlace(place) {
  const out = { name: place.name };
  if (place.category) out.category = place.category;
  if (place.subcategory) out.subcategory = place.subcategory;
  if (place.address) out.address = place.address;
  if (place.coordinates) out.coordinates = { lat: place.coordinates.lat, lng: place.coordinates.lon };
  return out;
}

function encodePointParam(name, c) {
  return encodeURIComponent(name + ',' + c.lat + ',' + c.lng);
}
