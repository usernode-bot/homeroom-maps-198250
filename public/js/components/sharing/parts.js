// Location sharing parts (Phase 12F) — the pieces both the screen and the
// start sheet are built from: the people picker, the duration picker, one
// incoming share row and the small status lines. Words come from the i18n
// layer; layout reuses the app's card, button and empty-state parts.
'use strict';

import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { t, getLocale } from '../../i18n/index.js';
import { formatRelative } from '../../i18n/format.js';
import {
  ageLabel,
  expiresInLabel,
  isStale,
  isVeryStale,
} from '../../services/sharing-core.js';

// The one bordered notice shape the offline-areas screen established.
export function noticeCard({ title, body, dataset } = {}) {
  return el('div', {
    class: 'rounded-card border border-line bg-surface px-4 py-4',
    ...(dataset ? { dataset } : {}),
  }, [
    el('p', { class: 'text-sm font-semibold text-ink', text: title || '' }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: body || '',
    }),
  ]);
}

// A status line with the live dot: green while updates flow, grey when the
// device is offline or the fix is failing, so the state is colour-and-words
// and never just colour.
export function statusLine(text, { tone = 'on' } = {}) {
  const dot =
    tone === 'on'
      ? 'h-2 w-2 rounded-full bg-green-500'
      : 'h-2 w-2 rounded-full bg-zinc-400';
  return el('p', {
    class: 'flex items-center gap-2 text-xs text-muted',
    dataset: { sharingStatusLine: tone },
  }, [
    el('span', { class: dot, 'aria-hidden': 'true' }),
    el('span', { text: text || '' }),
  ]);
}

// The people picker in the start sheet. The caller passes the roster
// (already filtered to exclude the signed-in person); rows toggle on tap and
// the screen re-renders the sheet body from its own state.
export function recipientPicker({ members, selectedIds, onToggle }) {
  const selected = new Set((selectedIds || []).map(String));
  const list = el('ul', {
    class: 'divide-y divide-line rounded-card border border-line bg-surface',
    dataset: { sharingPeople: 'true' },
  });
  for (const m of members) {
    const on = selected.has(String(m.id));
    const row = el('li', {}, [
      el('button', {
        type: 'button',
        class: 'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-ink',
        'aria-pressed': on ? 'true' : 'false',
        dataset: { personId: String(m.id), person: String(m.username) },
        onClick: () => onToggle(m),
      }, [
        el('span', { text: String(m.username) }),
        on
          ? el('span', { class: 'text-brand', 'aria-hidden': 'true' }, [icon('check', { class: 'h-4 w-4' })])
          : el('span', { class: 'text-xs text-muted', text: t('sharing.personAdd') }),
      ]),
    ]);
    list.append(row);
  }
  return list;
}

// The duration picker: exactly the three fixed lengths the API accepts.
export function durationPicker({ selected, onSelect }) {
  const options = [
    { minutes: 60, label: t('sharing.duration1') },
    { minutes: 480, label: t('sharing.duration8') },
    { minutes: 1440, label: t('sharing.duration24') },
  ];
  return el('div', {
    class: 'flex flex-col gap-2',
    dataset: { sharingDurations: 'true' },
  }, options.map((o) => {
    const on = o.minutes === selected;
    return el('button', {
      type: 'button',
      class:
        'flex w-full items-center justify-between gap-3 rounded-card border px-3 py-2 text-left text-sm text-ink ' +
        (on ? 'border-brand' : 'border-line'),
      'aria-pressed': on ? 'true' : 'false',
      dataset: { durationMinutes: String(o.minutes) },
      onClick: () => onSelect(o.minutes),
    }, [
      el('span', { text: o.label }),
      on
        ? el('span', { class: 'text-brand', 'aria-hidden': 'true' }, [icon('check', { class: 'h-4 w-4' })])
        : null,
    ]);
  }));
}

// One incoming share row. Muted (and flagged in a dataset) once its last fix
// is more than five minutes old, and plainly worded once it is past an hour.
export function shareRow({ share, onShow, onDismiss }) {
  const stale = isStale(share && share.fixAgeSeconds);
  const name = (share && share.sharer && share.sharer.username) || '?';
  const age = ageLabel(share && share.fixAgeSeconds, { t });
  return el('li', {
    class: 'flex flex-col gap-2 px-4 py-3' + (stale ? ' opacity-60' : ''),
    dataset: {
      shareRow: String((share && share.id) || ''),
      shareStale: stale ? 'true' : 'false',
      shareVeryStale: isVeryStale(share && share.fixAgeSeconds) ? 'true' : 'false',
    },
  }, [
    el('div', { class: 'flex items-baseline justify-between gap-2' }, [
      el('p', { class: 'text-sm font-semibold text-ink', text: name }),
      el('p', {
        class: 'shrink-0 text-xs text-muted',
        dataset: { shareAge: 'true' },
        text: age,
      }),
    ]),
    el('div', { class: 'flex flex-wrap gap-2' }, [
      onShow
        ? button(t('sharing.showOnMap'), { variant: 'secondary', onClick: onShow })
        : null,
      onDismiss
        ? button(t('sharing.dismiss'), { variant: 'ghost', onClick: onDismiss })
        : null,
    ]),
  ]);
}

// One recipient line on the owner's card: the name and, when the server sent
// a last-viewed time, when they last looked.
export function recipientRow(recipient) {
  const viewed =
    recipient && recipient.lastViewedAt
      ? ' ' + t('sharing.lastLooked', {
          ago: formatRelative(new Date(recipient.lastViewedAt), { locale: getLocale() }),
        })
      : '';
  return el('li', {
    class: 'flex items-center justify-between gap-3 py-2 text-sm text-ink',
    dataset: { sharingRecipient: String((recipient && recipient.username) || '') },
  }, [
    el('span', { text: String((recipient && recipient.username) || '?') }),
    viewed
      ? el('span', { class: 'text-xs text-muted', text: viewed.trim() })
      : el('span', { class: 'text-xs text-muted', text: t('sharing.notLookedYet') }),
  ]);
}

// "Expires in 42 min" for the owner's card, from the server's own expiry.
// The second parameter is optional: a caller that omits it (the sharing
// screen's renderOutgoing does) gets the shared t(), so a one-argument call
// can never break the whole screen again.
export function expiryLine(session, { t: translate } = {}) {
  const translateFn = translate || t;
  if (!session || !session.expiresAt) return null;
  const seconds = (new Date(session.expiresAt).getTime() - Date.now()) / 1000;
  return expiresInLabel(seconds, { t: translateFn });
}
