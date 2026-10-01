// Place Detail view — everything known about one place, in sections.
//
// Rendered from a Place Detail session (services/place-detail.js): the view
// is a pure function of the session snapshot. The header is the same reusable
// Place Card every other surface uses; the sections below it render each
// spec'd area — photos, location, contact, opening hours, rating — with the
// app's shared honest states:
//
//   loading      — a spinner strip while enrichment is in flight
//   unavailable  — no place provider is connected: summary data renders, and
//                  every missing field reads "Not available" under a plain
//                  one-line note. This is the state the app ships in.
//   error        — enrichment failed: the summary still renders and a Try
//                  again action re-runs the fetch.
//   photos       — a real photo list renders as tiles with per-image
//                  loading/failed states; an empty list reads "No photos".
//
// Deliberately NOT here: routing or navigation of any kind. Distance/direction
// actions belong to the directions phase, not to a place's detail.
import { el } from '../components/dom.js';
import { icon } from '../components/icons.js';
import { errorState } from '../components/error-state.js';
import { spinner } from '../components/loading.js';
import { createPlaceCard } from '../components/place/place-card.js';
import * as mapService from '../services/map.js';
import {
  NOT_AVAILABLE,
  openingHoursStatusLabel,
  ratingCountLabel,
  ratingLabel,
} from '../services/places-model.js';

// A muted, single-value fallback. Never bold, never an action: the field is
// simply not available.
function naValue() {
  return el('p', { class: 'text-sm text-muted', text: NOT_AVAILABLE });
}

function sectionHeading(text) {
  return el('p', {
    class: 'text-xs font-medium uppercase tracking-wide text-muted',
    text,
  });
}

// One label/value row. `value` is a node or a string; null renders the shared
// Not available value, so a missing field is explicit rather than absent.
function sectionRow(label, value) {
  return el('div', { class: 'flex items-baseline justify-between gap-4' }, [
    el('p', { class: 'shrink-0 text-sm text-muted', text: label }),
    typeof value === 'string'
      ? el('p', { class: 'min-w-0 break-words text-right text-sm text-ink', text: value })
      : value || naValue(),
  ]);
}

// One photo tile: loading shimmer, then the image, then an honest
// "could not load" block on failure. No retry inside the tile — a reload of
// the view re-fetches, and a photo URL that is dead stays honestly dead.
function photoTile(photo) {
  const box = el(
    'div',
    {
      class: 'relative aspect-[4/3] overflow-hidden rounded-lg bg-surface-raised',
      role: 'img',
      'aria-label': photo.attribution || 'Place photo',
    },
    [
      el('div', {
        class: 'absolute inset-0 animate-pulse bg-surface-raised',
        dataset: { photoLoading: 'true' },
      }),
    ],
  );
  const img = el('img', {
    src: photo.url,
    alt: photo.attribution || 'Place photo',
    class: 'absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity',
    loading: 'lazy',
  });
  img.addEventListener('load', () => {
    box.querySelector('[data-photo-loading]')?.remove();
    img.classList.remove('opacity-0');
  });
  img.addEventListener('error', () => {
    box.replaceChildren(
      el(
        'div',
        { class: 'absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center' },
        [
          icon('photo', { class: 'h-5 w-5 text-muted' }),
          el('p', { class: 'text-xs text-muted', text: 'Photo could not load' }),
        ],
      ),
    );
  });
  box.appendChild(img);
  return box;
}

function photosSection(place) {
  const photos = Array.isArray(place.photos) ? place.photos : [];
  const body = photos.length
    ? el('div', { class: 'grid grid-cols-2 gap-2 sm:grid-cols-3' }, photos.map(photoTile))
    : el('p', { class: 'text-sm text-muted leading-relaxed', text: 'No photos are available for this place.' });
  return el('section', { class: 'flex flex-col gap-2', dataset: { placeSection: 'photos' } }, [
    sectionHeading('Photos'),
    body,
  ]);
}

function locationSection(place) {
  const coords = place.coordinates;
  const coordinates =
    coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
      ? `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`
      : null;
  // The existing Map interface (services/map.js) is interface-only: no map
  // provider is connected. Its own isConfigured() gate decides what this
  // block may claim — nothing here pretends a map exists, and nothing here
  // offers routing or navigation.
  const mapNote = mapService.isConfigured() && coordinates
    ? null // the map phase replaces this note with the real canvas
    : el('div', {
        class:
          'flex min-h-16 items-center justify-center rounded-card border border-dashed border-line bg-surface-raised/60 px-4 py-3 text-center',
      }, [
        el('p', {
          class: 'text-sm text-muted leading-relaxed',
          text: coordinates
            ? 'Map is not available yet. No map provider is connected.'
            : 'Map is not available yet, and this place has no coordinates to centre on.',
        }),
      ]);
  return el('section', { class: 'flex flex-col gap-2', dataset: { placeSection: 'location' } }, [
    sectionHeading('Location'),
    el('div', { class: 'flex flex-col gap-1.5' }, [
      sectionRow('Address', place.address || null),
      sectionRow('Country', place.country || null),
      sectionRow('Coordinates', coordinates),
    ]),
    mapNote,
  ]);
}

function contactSection(place) {
  const website = place.website ? el('a', {
    href: place.website,
    target: '_blank',
    rel: 'noopener noreferrer',
    class: 'min-w-0 break-all text-right text-sm text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
    text: place.website.replace(/^https?:\/\//i, ''),
  }) : null;
  return el('section', { class: 'flex flex-col gap-2', dataset: { placeSection: 'contact' } }, [
    sectionHeading('Contact'),
    el('div', { class: 'flex flex-col gap-1.5' }, [
      sectionRow('Phone', place.phone || null),
      sectionRow('Website', website),
    ]),
  ]);
}

function hoursSection(place) {
  const hours = place.openingHours;
  const statusLabel = openingHoursStatusLabel(hours && hours.status);
  const rows = [
    el('div', { class: 'flex items-baseline justify-between gap-4' }, [
      el('p', { class: 'shrink-0 text-sm text-muted' }, ['Status']),
      statusLabel
        ? el('p', {
            class: 'flex items-center gap-1.5 text-sm font-medium text-ink',
            dataset: { placeHoursStatus: hours.status },
          }, [icon('clock', { class: 'h-4 w-4 text-muted' }), statusLabel])
        : naValue(),
    ]),
  ];
  const weekdayText = (hours && Array.isArray(hours.weekdayText) && hours.weekdayText) || [];
  if (weekdayText.length) {
    rows.push(
      el('div', { class: 'mt-1 flex flex-col gap-1' }, weekdayText.map((row) =>
        el('p', { class: 'text-sm text-muted', text: row }))),
    );
  }
  return el('section', { class: 'flex flex-col gap-2', dataset: { placeSection: 'hours' } }, [
    sectionHeading('Opening hours'),
    el('div', { class: 'flex flex-col gap-1.5' }, rows),
  ]);
}

function ratingSection(place) {
  const rating = ratingLabel(place.rating);
  const count = ratingCountLabel(place.rating && place.rating.count);
  const value = rating
    ? el('p', { class: 'flex items-center gap-1.5 text-sm font-medium text-ink' }, [
        icon('star', { class: 'h-4 w-4 text-muted' }),
        rating,
        count ? el('span', { class: 'text-muted', text: `· ${count}` }) : null,
      ])
    : null;
  return el('section', { class: 'flex flex-col gap-2', dataset: { placeSection: 'rating' } }, [
    sectionHeading('Rating'),
    // A rating exists only when a provider supplied one; nothing is ever
    // fabricated here, so the fallback is the honest Not available.
    value || naValue(),
  ]);
}

export function createPlaceDetailView({ session, onBack, onSave }) {
  const root = el('div', { class: 'flex flex-col gap-4', dataset: { placeDetail: 'true' } });
  const backRow = el('div', { class: 'flex items-center gap-2' }, [
    el(
      'button',
      {
        type: 'button',
        class:
          'rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        dataset: { placeDetailBack: 'true' },
      },
      ['Back'],
    ),
    // Save: the caller decides whether this place can be saved (signed in,
    // coordinates present); without onSave there is no button at all.
    typeof onSave === 'function'
      ? el(
          'button',
          {
            type: 'button',
            class:
              'rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            dataset: { placeDetailSave: 'true' },
          },
          ['Save'],
        )
      : null,
  ]);
  backRow.querySelector('[data-place-detail-back]').addEventListener('click', () => onBack && onBack());
  const saveBtn = backRow.querySelector('[data-place-detail-save]');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      try {
        await onSave(session.getState().place);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
  root.appendChild(backRow);

  function update(state) {
    const place = state.place || {};
    const header = createPlaceCard(place, {});
    header.setAttribute('data-place-detail-header', 'true');
    header.setAttribute('aria-label', `${place.name} details`);

    const strips = [];
    if (state.phase === 'loading') {
      strips.push(
        el('div', { class: 'flex items-center gap-3', role: 'status' }, [
          spinner(),
          el('p', { class: 'text-sm text-muted', text: 'Loading place details…' }),
        ]),
      );
    } else if (state.phase === 'unavailable') {
      strips.push(
        el('p', {
          class: 'rounded-card border border-dashed border-line bg-surface/60 px-4 py-3 text-sm text-muted leading-relaxed',
          role: 'status',
          text:
            'Full place details are not available yet: no place provider is connected. What the search data carries is shown below.',
        }),
      );
    } else if (state.phase === 'error') {
      strips.push(
        errorState({
          title: 'Place details are unavailable right now',
          description:
            (state.error && state.error.message) ||
            'We could not load the details for this place. Try again in a moment.',
          onRetry: () => session.retry(),
        }),
      );
    }

    root.replaceChildren(
      backRow,
      header,
      ...strips,
      photosSection(place),
      locationSection(place),
      contactSection(place),
      hoursSection(place),
      ratingSection(place),
    );
  }

  update(session.getState());
  return { root, update };
}