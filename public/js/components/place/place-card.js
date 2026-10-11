// Place Card — THE one reusable card for a place, used everywhere a place
// appears (the Discover results list, the Place Detail header; later phases
// get it for free).
//
// Every optional field renders ONLY when real data exists, exactly per the
// spec: name, category, address, distance, rating, business status,
// verification status, thumbnail and data source are each omitted — not
// placeholdered — when the place does not carry them. The gating logic lives
// in places-model.js (import-free, unit-tested); this module is the DOM
// projection of it. What this card never does: invent a rating, a photo, a
// distance or a status the data does not carry.
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { isOffline } from '../../services/search.js';
import { t } from '../../i18n/index.js';
import {
  categoryLabel,
  businessStatusLabel,
  distanceLabel,
  ratingCountLabel,
  ratingLabel,
  verificationStatusLabel,
} from '../../services/places-model.js';

const BADGE_CLASSES =
  'inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium';

// A thumbnail from the place's first real photo, with an honest failure
// state: an image that cannot load collapses back to the pin glyph rather
// than rendering a broken-image artefact. No photo means no thumbnail at all.
function thumbnail(photo) {
  const fallback = () =>
    icon('pin', { class: 'h-5 w-5 text-muted' });
  const frame = el(
    'span',
    {
      class:
        'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-raised text-muted',
      'aria-hidden': 'true',
    },
    [fallback()],
  );
  if (!photo || typeof photo.url !== 'string' || !photo.url) return frame;
  const img = el('img', {
    src: photo.url,
    alt: '',
    class: 'h-12 w-12 rounded-lg object-cover',
    loading: 'lazy',
  });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  frame.replaceChildren(img);
  return frame;
}

export function createPlaceCard(place, { onSelect } = {}) {
  if (!place || typeof place !== 'object' || !place.name) return null;

  const category = categoryLabel(place);
  const distance = distanceLabel(place.distanceKm);
  const rating = ratingLabel(place.rating);
  const ratingCount = ratingCountLabel(place.rating && place.rating.count);
  const business = businessStatusLabel(place.businessStatus);
  const verification = verificationStatusLabel(place.verificationStatus);
  const dataSource =
    typeof place.dataSource === 'string' && place.dataSource && place.dataSource !== 'unknown'
      ? place.dataSource
      : null;

  const lines = [];
  if (category || distance) {
    lines.push(
      el('p', { class: 'truncate text-sm text-muted' }, [
        category || '',
        category && distance ? ' · ' : '',
        distance || '',
      ]),
    );
  }
  if (place.address) {
    lines.push(el('p', { class: 'truncate text-sm text-muted', text: place.address }));
  }
  if (rating) {
    lines.push(
      el('p', { class: 'flex items-center gap-1 text-sm text-ink' }, [
        icon('star', { class: 'h-4 w-4 text-muted' }),
        `${rating}`,
        ratingCount ? el('span', { class: 'text-muted', text: `· ${ratingCount}` }) : null,
      ]),
    );
  }
  if (business || verification) {
    lines.push(
      el('p', { class: 'flex flex-wrap items-center gap-1.5' }, [
        business
          ? el(
              'span',
              {
                class: `${BADGE_CLASSES} ${
                  place.businessStatus === 'coming_soon'
                    ? 'bg-accent-soft text-accent'
                    : 'border border-line text-danger'
                }`,
                dataset: { placeBusinessStatus: place.businessStatus },
              },
              [business],
            )
          : null,
        verification
          ? el(
              'span',
              {
                class: `${BADGE_CLASSES} bg-accent-soft text-accent`,
                dataset: { placeVerificationStatus: place.verificationStatus },
              },
              [icon('check', { class: 'h-3.5 w-3.5' }), verification],
            )
          : null,
      ]),
    );
  }

  // A place that came from a downloaded region is marked Offline, so the
  // Discover list never presents device-local data as a live result.
  const offline = Boolean(place.offline) || isOffline();

  const body = [
    thumbnail(place.photos && place.photos[0]),
    el('span', { class: 'min-w-0 flex-1' }, [
      el('span', { class: 'flex items-center gap-1.5' }, [
        el('span', { class: 'block truncate text-base font-semibold text-ink', text: place.name }),
        offline
          ? el('span', {
              class:
                'inline-flex shrink-0 items-center rounded-pill border border-line bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted',
              dataset: { offlineBadge: 'true' },
              text: t('offline.searchBadge'),
            })
          : null,
      ]),
      ...lines,
      dataSource
        ? el('span', {
            class: 'mt-0.5 block text-[11px] text-muted',
            text: `Data: ${dataSource}`,
          })
        : null,
    ]),
  ];

  // With an onSelect the card is a tappable button; without one (the Place
  // Detail header) it is the same surface as a plain, non-interactive block.
  if (onSelect) {
    const cardButton = el(
      'button',
      {
        type: 'button',
        class:
          'flex w-full items-start gap-3 rounded-card border border-line bg-surface p-4 text-left shadow-sm transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        dataset: { placeCard: 'true', placeId: place.id },
      },
      body,
    );
    cardButton.addEventListener('click', () => onSelect(place));
    return cardButton;
  }
  return el(
    'div',
    {
      class: 'flex w-full items-start gap-3 rounded-card border border-line bg-surface p-4 text-left shadow-sm',
      dataset: { placeCard: 'true', placeId: place.id },
    },
    body,
  );
}