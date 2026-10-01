// Route summary — the reusable card for one calculated route.
//
// Shows the line people plan with ("12.4 km · 24 min"), the travel mode, and
// the road/restriction information the provider actually returned. Nothing
// here invents a value: a distance or duration the provider did not supply
// reads "Distance unavailable" / "Duration unavailable", and road details
// that were not surfaced are stated as unavailable rather than skipped
// silently.
//
// Used for the selected route and for each alternative in the list; when
// `onSelect` is given the card is a real radio option (alternative routes),
// otherwise it is a static summary.
import { el } from './dom.js';
import { card } from './card.js';
import { routeLine, formatDistance, formatDuration } from '../services/routing-core.js';

export function routeSummary({ route, modeLabel, selected = false, onSelect = null, viaPrefix = 'Via' } = {}) {
  const selectable = typeof onSelect === 'function';
  const roads = route && Array.isArray(route.roadInformation) ? route.roadInformation : [];
  const restrictions = route && Array.isArray(route.restrictions) ? route.restrictions : [];

  const line = el(
    'p',
    { class: 'text-lg font-semibold tracking-tight text-ink', dataset: { routeLine: 'true' } },
    [routeLine(route)],
  );

  const facts = [line];
  facts.push(
    el('p', { class: 'mt-0.5 text-sm text-muted', dataset: { routeMode: 'true' } },
      [modeLabel || 'Travel mode unavailable']),
  );

  if (roads.length) {
    facts.push(
      el('p', { class: 'mt-1 text-sm text-ink leading-snug', dataset: { routeRoads: 'true' } },
        [`${viaPrefix} ${roads.slice(0, 3).join(', ')}`]),
    );
  }
  if (restrictions.length) {
    facts.push(
      el('p', { class: 'mt-1 text-sm text-danger', dataset: { routeRestrictions: 'true' } },
        [restrictions.join(', ')]),
    );
  }
  if (!roads.length && !restrictions.length) {
    facts.push(
      el('p', { class: 'mt-1 text-sm text-muted', dataset: { routeRoads: 'true' } },
        ['Road details unavailable from the routing provider.']),
    );
  }

  const body = el('div', { class: 'min-w-0' }, facts);

  if (!selectable) {
    return card([body], { attrs: { dataset: { routeSummary: 'true' } } });
  }

  // An alternative option: the whole card is the tap target, with radio
  // semantics so assistive tech announces which route is active.
  const option = el(
    'button',
    {
      type: 'button',
      class: [
        'block w-full text-left rounded-card border bg-surface p-4 transition-colors text-left',
        selected
          ? 'border-brand ring-1 ring-brand'
          : 'border-line hover:bg-surface-raised',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      ].join(' '),
      role: 'radio',
      'aria-checked': selected ? 'true' : 'false',
      dataset: { routeOption: selected ? 'true' : 'false' },
    },
    [body],
  );
  option.addEventListener('click', () => onSelect());
  return option;
}

// The compact distance/duration pair used inside rows (waypoint legs, later
// phases). Null-safe on both halves.
export function routeStatLine(route) {
  const distance = formatDistance(route && route.distance);
  const duration = formatDuration(route && route.duration);
  return [distance, duration].filter(Boolean).join(' · ') || 'Unavailable';
}
