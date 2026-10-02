// Trip components — the reusable pieces the Trips screen renders: a trip card
// for the list, a day section with its numbered itinerary rows, and the small
// controls between them. Everything is built from the app's existing el/card/
// button/icon primitives and reads its copy through the i18n layer, so no
// user-facing string is hard-coded here.
//
// The numbered marker is a plain ordered chip, not a map pin: itinerary order
// reads correctly even where no map is available, exactly like the fallback
// the spec allows.
import { el } from '../dom.js';
import { button } from '../button.js';
import { card } from '../card.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';

// One numbered, circular order chip.
export function orderChip(number) {
  return el('span', {
    class:
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-contrast',
    'aria-hidden': 'true',
    text: String(number),
  });
}

// A trip row on the list. `onOpen` opens its detail.
export function tripCard(trip, { onOpen } = {}) {
  const range = trip.startDate === trip.endDate ? trip.startDate : trip.startDate + ' – ' + trip.endDate;
  return card(
    [
      el('div', { class: 'flex items-start justify-between gap-3' }, [
        el('div', { class: 'flex min-w-0 flex-col gap-1' }, [
          el('p', { class: 'truncate text-base font-semibold text-ink', text: trip.name }),
          trip.destination && trip.destination.name
            ? el('p', { class: 'flex min-w-0 items-center gap-1 text-xs text-muted' }, [
                icon('pin', { class: 'h-3.5 w-3.5 shrink-0' }),
                el('span', { class: 'truncate', text: trip.destination.name }),
              ])
            : null,
        ]),
        el('span', {
          class: 'shrink-0 rounded-pill bg-surface-raised px-2.5 py-1 text-xs font-medium text-muted',
          text: range,
        }),
      ]),
      el('p', {
        class: 'mt-2 text-xs text-muted',
        text: t('trips.listMeta', { days: trip.dayCount == null ? 0 : trip.dayCount, stops: trip.itemCount == null ? 0 : trip.itemCount }),
      }),
      el('div', { class: 'mt-3' }, [
        button(t('trips.open'), { variant: 'secondary', onClick: () => onOpen && onOpen(trip) }),
      ]),
    ],
    { attrs: { dataset: { tripCard: trip.id } } },
  );
}

// A leg line between two consecutive stops. `info` is
// { state: 'ready' | 'unavailable' | 'error', text, onShow }. Rendered by the
// screen only for pairs the provider could actually route.
export function legRow(info) {
  const tone =
    info.state === 'error'
      ? 'text-muted'
      : info.state === 'unavailable'
        ? 'text-muted'
        : 'text-ink';
  const children = [
    el('span', { class: 'h-6 w-px bg-line', 'aria-hidden': 'true' }),
    el('span', { class: 'flex items-center gap-1 text-xs ' + tone }, [
      icon('directions', { class: 'h-3.5 w-3.5 text-muted' }),
      el('span', { text: info.text }),
    ]),
  ];
  if (info.state === 'unavailable' && info.onShow) {
    children.push(
      el('button', {
        type: 'button',
        class:
          'rounded-pill px-2 py-0.5 text-xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        dataset: { legShow: 'true' },
        text: t('trips.leg.show'),
        onClick: info.onShow,
      }),
    );
  }
  return el(
    'div',
    { class: 'flex items-center gap-2 pl-1', dataset: { tripLeg: info.state } },
    children,
  );
}

// One itinerary row: numbered chip, place summary, optional time/duration,
// the honest opening-hours line, and the row's actions.
export function itemRow(item, { number, actions } = {}) {
  const place = item.place || {};
  const hasCoordinates = Boolean(
    place.coordinates &&
      Number.isFinite(Number(place.coordinates.lat)) &&
      Number.isFinite(Number(place.coordinates.lng != null ? place.coordinates.lng : place.coordinates.lon)),
  );
  const details = [];
  if (place.address) details.push(place.address);
  if (place.category) details.push(place.category);
  details.push(t('trips.hoursUnavailable'));

  const timeBits = [];
  if (item.startTime) timeBits.push(item.startTime);
  if (item.durationMinutes != null) timeBits.push(t('trips.item.minutes', { minutes: item.durationMinutes }));

  const controls = el('div', { class: 'mt-2 flex flex-wrap gap-1.5' }, [
    button(t('trips.item.viewPlace'), {
      variant: 'ghost',
      class: 'px-2 py-1 text-xs',
      onClick: () => actions.viewPlace(item),
    }),
    button(t('trips.item.directions'), {
      variant: 'ghost',
      class: 'px-2 py-1 text-xs',
      onClick: () => actions.directions(item),
    }),
    button(t('trips.item.navigate'), {
      variant: 'ghost',
      class: 'px-2 py-1 text-xs',
      disabled: !hasCoordinates,
      attrs: { title: hasCoordinates ? '' : t('trips.item.needsCoordinates') },
      onClick: () => actions.navigate(item),
    }),
    button(t('trips.item.moveUp'), {
      variant: 'ghost',
      class: 'px-2 py-1 text-xs',
      disabled: !actions.canMoveUp,
      onClick: () => actions.moveUp(item),
    }),
    button(t('trips.item.moveDown'), {
      variant: 'ghost',
      class: 'px-2 py-1 text-xs',
      disabled: !actions.canMoveDown,
      onClick: () => actions.moveDown(item),
    }),
    button(t('trips.item.remove'), {
      variant: 'ghost',
      class: 'px-2 py-1 text-xs',
      onClick: () => actions.remove(item),
    }),
  ]);

  return el('li', { class: 'flex gap-3 py-3', dataset: { tripItem: item.id } }, [
    orderChip(number),
    el('div', { class: 'flex min-w-0 flex-1 flex-col' }, [
      el('p', { class: 'text-sm font-semibold leading-snug text-ink', text: place.name || item.placeId }),
      el('p', { class: 'mt-0.5 text-xs text-muted', text: details.filter(Boolean).join(' · ') }),
      timeBits.length
        ? el('p', { class: 'mt-0.5 flex items-center gap-1 text-xs text-muted' }, [
            icon('clock', { class: 'h-3.5 w-3.5 shrink-0' }),
            el('span', { text: timeBits.join(' · ') }),
          ])
        : null,
      item.notes ? el('p', { class: 'mt-1 text-xs text-muted leading-relaxed', text: item.notes }) : null,
      controls,
    ]),
    el('div', { class: 'flex flex-col items-center gap-1' }, [
      el('label', { class: 'text-[10px] uppercase tracking-wide text-muted', text: t('trips.item.day') }),
      el('select', {
        class:
          'rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        'aria-label': t('trips.item.moveToDay'),
        dataset: { tripItemDay: item.id },
        onChange: (e) => actions.moveToDay(item, e.target.value),
      }, actions.dayOptions.map((opt) =>
        el('option', { value: opt.value, selected: opt.selected ? true : null, text: opt.label }),
      )),
    ]),
  ]);
}

// One day: heading (number, weekday+date, stop count) plus its itinerary rows
// with the leg lines between consecutive routable stops.
export function daySection(day, { index, legFor, actions, onAddPlace } = {}) {
  const rows = [];
  day.items.forEach((item, i) => {
    if (i > 0) {
      const leg = legFor(day.items[i - 1], item);
      if (leg) rows.push(legRow(leg));
    }
    rows.push(
      itemRow(item, {
        number: i + 1,
        actions: actions(item, i),
      }),
    );
  });

  return el('section', { class: 'flex flex-col gap-2', dataset: { tripDay: day.id } }, [
    el('div', { class: 'flex items-center justify-between gap-3' }, [
      el('div', { class: 'flex flex-col' }, [
        el('p', { class: 'text-sm font-semibold text-ink', text: t('trips.day.heading', { day: index + 1 }) }),
        el('p', { class: 'text-xs text-muted', text: day.label || day.date }),
      ]),
      button(t('trips.day.addPlace'), {
        variant: 'secondary',
        class: 'px-3 py-1.5 text-xs',
        attrs: { dataset: { tripAddPlace: day.id } },
        onClick: () => onAddPlace && onAddPlace(day),
      }),
    ]),
    day.items.length
      ? el('ul', { class: 'divide-y divide-line rounded-card border border-line bg-surface px-3' }, rows)
      : el('p', {
          class: 'rounded-card border border-dashed border-line bg-surface/60 px-3 py-4 text-center text-xs text-muted',
          text: t('trips.day.empty'),
        }),
  ]);
}
