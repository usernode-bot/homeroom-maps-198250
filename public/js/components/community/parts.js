// Small shared pieces of the community UI: the status pill, relative time,
// and the vote control. Pill classes are whole literals so the Tailwind
// extractor sees them.
import { el } from '../dom.js';
import { icon } from '../icons.js';

const PILL_CLASSES = {
  draft: 'bg-surface-raised text-muted',
  open: 'bg-accent-soft text-accent',
  under_review: 'bg-accent-soft text-accent',
  accepted: 'bg-accent-soft text-accent',
  rejected: 'bg-surface-raised text-muted',
  implemented: 'bg-accent-soft text-accent',
};

export function statusPill(proposal) {
  return el('span', {
    class: `inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-xs font-medium ${PILL_CLASSES[proposal.status] || PILL_CLASSES.draft}`,
    text: proposal.statusLabel,
    dataset: { status: proposal.status },
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

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function voteButton(direction, proposal, { onVote, busy }) {
  const pressed = proposal.viewer.vote === direction;
  const up = direction === 1;
  const count = up ? proposal.votes.up : proposal.votes.down;
  const disabled = busy || !proposal.viewer.canVote;
  return el(
    'button',
    {
      type: 'button',
      class: [
        'un-touch-target inline-flex items-center justify-center rounded-pill p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40',
        pressed ? 'bg-accent-soft text-brand' : 'text-muted hover:text-ink',
      ].join(' '),
      'aria-pressed': pressed ? 'true' : 'false',
      'aria-label': `${up ? 'Upvote' : 'Downvote'} (${count})${pressed ? ', your vote. Tap again to withdraw it' : ''}`,
      title: proposal.viewer.canVote ? (up ? 'Upvote' : 'Downvote') : proposal.viewer.voteBlockedReason || '',
      disabled,
      dataset: { vote: up ? 'up' : 'down' },
      onClick: () => onVote(direction),
    },
    [icon(up ? 'arrow-up' : 'arrow-down', { class: 'h-4 w-4' })],
  );
}

// Vertical control for feed rows: up, score, down. The score is the server's
// up minus down; nothing here adjusts it before the server answers.
export function voteColumn(proposal, { onVote, busy = false } = {}) {
  return el(
    'div',
    {
      class: 'flex w-10 shrink-0 flex-col items-center gap-0.5 pt-1',
      dataset: { voteControl: proposal.id },
      title: `${proposal.votes.up} up, ${proposal.votes.down} down`,
    },
    [
      voteButton(1, proposal, { onVote, busy }),
      el('span', {
        class: 'text-sm font-semibold tabular-nums text-ink',
        text: String(proposal.votes.score),
        dataset: { score: 'true' },
      }),
      voteButton(-1, proposal, { onVote, busy }),
    ],
  );
}

// Horizontal control for the detail view, with both counts spelled out.
export function voteBar(proposal, { onVote, busy = false } = {}) {
  return el('div', { class: 'flex flex-col gap-2', dataset: { voteControl: proposal.id } }, [
    el('div', { class: 'flex items-center gap-3' }, [
      el('div', { class: 'flex items-center gap-1' }, [
        voteButton(1, proposal, { onVote, busy }),
        el('span', { class: 'text-sm tabular-nums text-ink', text: `${proposal.votes.up} up`, dataset: { upCount: 'true' } }),
      ]),
      el('div', { class: 'flex items-center gap-1' }, [
        voteButton(-1, proposal, { onVote, busy }),
        el('span', { class: 'text-sm tabular-nums text-ink', text: `${proposal.votes.down} down`, dataset: { downCount: 'true' } }),
      ]),
      el('span', { class: 'text-sm text-muted', text: `Score ${proposal.votes.score}`, dataset: { score: 'true' } }),
    ]),
    proposal.viewer.canVote
      ? el('p', {
          class: 'text-xs text-muted',
          text: proposal.viewer.vote ? 'You voted. Tap your vote again to withdraw it.' : 'One vote per person. You can change it while voting is open.',
        })
      : el('p', { class: 'text-xs text-muted', text: proposal.viewer.voteBlockedReason || '' }),
  ]);
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
  console.info('[community] ' + message);
}
