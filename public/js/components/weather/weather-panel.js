// The weather panel (Phase 12G) — the surface presented over the map when
// the Weather control is tapped. It renders ONLY what the session state
// says, and its whole vocabulary is the honest one:
//
//   unavailable — no authorized provider (W1); no data is ever shown
//   loading     — a request is in flight; nothing numeric yet
//   ready       — a fresh reading with its observed time and source
//   stale       — the same reading, labelled as old, with the refresh
//                 emphasized
//   offline     — the device has no connection; no request was made
//   error       — the server or the payload failed; a retry is offered
//
// The panel is a pure view over the shared weather session: it subscribes,
// re-renders, and never fetches on its own.
'use strict';

import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { loading } from '../loading.js';
import { t } from '../../i18n/index.js';
import { formatTime } from '../../i18n/format.js';
import {
  formatPrecipitation,
  formatTemperature,
  formatWind,
} from '../../services/weather-core.js';
import {
  refreshWeather,
  recheckWeather,
  subscribeWeather,
  weatherState,
} from '../../services/weather.js';
import { activeUnits } from '../../i18n/format.js';

// The notice card the unavailable/offline/error states render: the same
// blocked-card shape the offline areas screen uses (rounded-card, dataset
// marker, title + body + optional action).
function noticeCard({ marker, title, body, action }) {
  const card = el(
    'div',
    {
      class: 'rounded-card border border-line bg-surface px-4 py-4',
      dataset: { weatherNotice: marker },
    },
    [
      el('p', { class: 'text-sm font-semibold text-ink', text: title }),
      el('p', { class: 'mt-1 text-sm text-muted leading-relaxed', text: body }),
    ],
  );
  if (action) card.append(action);
  return card;
}

// One rendered field row, or nothing when the reading does not carry the
// field. Only the declared field keys ever produce rows.
function fieldRow(label, value) {
  if (value == null) return null;
  return el(
    'div',
    { class: 'flex items-baseline justify-between gap-3', dataset: { weatherField: 'true' } },
    [
      el('span', { class: 'text-sm text-muted', text: label }),
      el('span', { class: 'text-sm font-medium text-ink', text: value }),
    ],
  );
}

function stateBody(state) {
  const scope = el('p', { class: 'text-xs text-muted', text: t('weather.scope') });

  if (state.name === 'unavailable') {
    return [
      noticeCard({
        marker: 'capability_unavailable',
        title: t('weather.unavailableTitle'),
        body: t('weather.unavailableBody'),
        action: button(t('weather.checkAgain'), {
          variant: 'secondary',
          class: 'mt-3',
          onClick: () => recheckWeather(),
        }),
      }),
      scope,
    ];
  }

  if (state.name === 'loading') {
    return [loading({ label: t('weather.loading') })];
  }

  if (state.name === 'offline') {
    return [
      noticeCard({
        marker: 'offline',
        title: t('weather.offlineTitle'),
        body: t('weather.offlineBody'),
        action: button(t('weather.checkAgain'), {
          variant: 'secondary',
          class: 'mt-3',
          onClick: () => refreshWeather(),
        }),
      }),
      scope,
    ];
  }

  if (state.name === 'error') {
    return [
      noticeCard({
        marker: 'error',
        title: t('weather.errorTitle'),
        body: t('weather.errorBody'),
        action: button(t('weather.checkAgain'), {
          variant: 'secondary',
          class: 'mt-3',
          onClick: () => refreshWeather(),
        }),
      }),
      scope,
    ];
  }

  // ready and stale share the reading layout; stale adds its own note and
  // keeps the refresh prominent. A reading exists only in these two states
  // by the session's own rule.
  const reading = state.reading;
  const units = activeUnits();
  const observedTemplate = reading.observedAtEstimated ? 'weather.updated' : 'weather.observed';
  const observedAt = t(observedTemplate, { time: formatTime(new Date(reading.observedAt)) });

  const refreshButton = button(t('weather.refresh'), {
    variant: state.name === 'stale' ? 'primary' : 'secondary',
    class: 'mt-1',
    onClick: () => refreshWeather(),
  });

  const rows = el('div', { class: 'flex flex-col gap-2' });
  const temperature = formatTemperature(reading.temperatureC, units);
  const precipitation = formatPrecipitation(reading.precipitationMmH, units);
  const wind = formatWind(reading.windSpeedMs, units);
  for (const [label, value] of [
    [t('weather.temperature'), temperature],
    [t('weather.precipitation'), precipitation],
    [t('weather.wind'), wind],
  ]) {
    const row = fieldRow(label, value);
    if (row) rows.append(row);
  }

  const parts = [
    el('div', { class: 'rounded-card border border-line bg-surface px-4 py-4' }, [
      rows,
      el('p', { class: 'mt-2 text-xs text-muted', text: observedAt }),
    ]),
  ];
  if (state.name === 'stale') {
    parts.push(
      el('p', {
        class: 'text-xs text-amber-700 dark:text-amber-400',
        dataset: { weatherStale: 'true' },
        text: t('weather.stale'),
      }),
    );
  }
  parts.push(
    el('p', { class: 'text-xs text-muted', text: t('weather.source', { provider: reading.attribution }) }),
    refreshButton,
    scope,
  );
  return parts;
}

// Build the panel. Returns { root, destroy } — the caller presents `root`,
// wires onDismiss handling on its own surface, and calls destroy() when the
// surface dismisses, to unsubscribe.
export function createWeatherPanel({ onClose } = {}) {
  const root = el('div', {
    class: 'flex flex-col gap-3',
    dataset: { weatherPanel: 'true' },
  });
  const title = el('p', { class: 'text-base font-semibold text-ink', text: t('weather.title') });
  const closeBtn = el(
    'button',
    {
      type: 'button',
      class:
        'un-touch-target rounded-full p-1.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-label': t('weather.close'),
    },
    [icon('close', { class: 'h-5 w-5' })],
  );
  const header = el('div', { class: 'flex items-start justify-between gap-2' }, [title, closeBtn]);
  const stateRegion = el('div', {
    class: 'flex flex-col gap-3',
    role: 'status',
    'aria-live': 'polite',
    dataset: { weatherStateRegion: 'true' },
  });
  root.append(header, stateRegion);

  let unsubscribe = null;
  function render(state) {
    root.dataset.weatherState = state.name;
    stateRegion.replaceChildren(...stateBody(state));
  }

  unsubscribe = subscribeWeather(render);
  render(weatherState());

  const panel = {
    root,
    destroy() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
  closeBtn.addEventListener('click', () => {
    if (onClose) onClose();
  });
  return panel;
}
