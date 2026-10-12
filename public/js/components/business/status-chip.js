// Small shared pieces of the business UI (Phase 12J): the status chip for a
// claim or a profile, and relative time. Chip classes are whole literals so
// the Tailwind extractor sees them, the same discipline as the community
// parts. Verified is the only "good news" colour: it is reserved exclusively
// for a reviewer's decision, so it never borrows the accent for anything a
// person did themselves.
import { el } from '../dom.js';

const CHIP_CLASSES = {
  // claims
  pending: 'bg-surface-raised text-muted',
  verified: 'bg-accent-soft text-accent',
  rejected: 'bg-surface-raised text-muted',
  withdrawn: 'bg-surface-raised text-muted',
  superseded: 'bg-surface-raised text-muted',
  // profiles
  active: 'bg-accent-soft text-accent',
  suspended: 'bg-surface-raised text-muted',
};

export function statusChip(status, label) {
  return el('span', {
    class: `inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-xs font-medium ${CHIP_CLASSES[status] || CHIP_CLASSES.pending}`,
    text: label || status,
    dataset: { statusChip: status },
  });
}

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Math.abs(seconds) < 60) return 'just now';
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function toast(message, { error = false } = {}) {
  const kit = window.unNative;
  if (kit && typeof kit.toast === 'function') {
    try {
      kit.toast(message, error ? { priority: true } : {});
      return;
    } catch {
      /* fall through */
    }
  }
  console.info('[business] ' + message);
}
