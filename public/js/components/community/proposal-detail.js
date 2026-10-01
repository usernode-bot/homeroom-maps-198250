// One proposal, presented over the Community screen: what it proposes, where,
// its photos, the vote control, the actions this viewer may take, and the
// status history. Every action re-renders from the server's answer, and the
// feed row is updated through onChanged.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { loading } from '../loading.js';
import { errorState } from '../error-state.js';
import { present } from '../surface.js';
import { statusPill, voteBar, timeAgo, formatDate, toast } from './parts.js';
import { getProposal, castVote, changeStatus } from '../../services/community.js';
import { openProposalForm } from './proposal-form.js';

// Labels for the moves a viewer can make, by target status.
const MOVE_LABELS = {
  open: { label: 'Publish', from: { draft: 'Publish', under_review: 'Reopen for votes' } },
  under_review: { label: 'Start review' },
  accepted: { label: 'Accept' },
  rejected: { label: 'Reject' },
  implemented: { label: 'Mark implemented' },
};
const MOVE_TOASTS = {
  open: 'Published',
  under_review: 'Moved to Under Review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  implemented: 'Marked implemented',
};

function moveLabel(from, to) {
  const m = MOVE_LABELS[to];
  return (m.from && m.from[from]) || m.label;
}

// opts: { id, meta, onChanged(proposal) }
export function openProposalDetail({ id, meta, onChanged }) {
  const body = el('div', { class: 'flex flex-col gap-4 p-1', dataset: { proposalDetail: id } }, [
    loading({ label: 'Loading proposal' }),
  ]);
  const surface = present(body, { label: 'Proposal' });
  let busy = false;

  async function load() {
    body.replaceChildren(loading({ label: 'Loading proposal' }));
    try {
      render(await getProposal(id));
    } catch (err) {
      body.replaceChildren(
        errorState({
          title: err && err.status === 404 ? 'This proposal is not available' : 'This proposal could not load',
          description: (err && err.message) || 'Please try again.',
          onRetry: err && err.status === 404 ? null : load,
        }),
      );
    }
  }

  async function act(fn, success) {
    if (busy) return;
    busy = true;
    body.querySelectorAll('button').forEach((b) => (b.disabled = true));
    let result = null;
    let failure = null;
    try {
      result = await fn();
    } catch (err) {
      failure = err;
    }
    busy = false;
    if (failure) {
      toast((failure && failure.message) || 'That did not work. Please try again.', { error: true });
      render(current);
      return;
    }
    const p = result.proposal || result;
    if (success) toast(typeof success === 'function' ? success(result) : success);
    // Votes answer without the history; keep the one we have.
    render(p.history ? p : { ...p, history: current.history });
    if (onChanged) onChanged(p);
  }

  let current = null;
  function render(p) {
    current = p;
    const isReviewerMove = (to) => to !== 'open' || p.status !== 'draft';
    const authorMoves = p.viewer.transitions.filter((t) => !isReviewerMove(t));
    const reviewerMoves = p.viewer.transitions.filter(isReviewerMove);

    // Optional parts are null; replaceChildren would print them as text.
    body.replaceChildren(
      ...[
      el('div', { class: 'flex flex-wrap items-center gap-2 pr-8' }, [
        statusPill(p),
        el('span', { class: 'text-xs text-muted', text: p.categoryLabel }),
      ]),
      el('h2', { class: 'text-lg font-semibold leading-snug text-ink', text: p.title }),
      el('p', {
        class: 'text-xs text-muted',
        text: `Proposed by ${p.author.username}, ${p.publishedAt ? formatDate(p.publishedAt) : `draft started ${formatDate(p.createdAt)}`}`,
      }),
      p.location
        ? el('div', { class: 'flex items-start gap-1.5' }, [
            icon('pin', { class: 'mt-0.5 h-4 w-4 shrink-0 text-muted' }),
            el('div', { class: 'flex flex-col' }, [
              el('span', { class: 'text-sm text-ink', text: p.location.name }),
              el('span', { class: 'text-xs text-muted', text: `${p.location.lat.toFixed(4)}, ${p.location.lng.toFixed(4)}` }),
            ]),
          ])
        : null,
      el('p', { class: 'whitespace-pre-line text-sm leading-relaxed text-ink', text: p.description }),
      p.attachments.length
        ? el(
            'div',
            { class: 'flex flex-wrap gap-2' },
            p.attachments.map((a) =>
              el('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, [
                el('img', { src: a.url, alt: a.filename || 'Attached photo', class: 'h-24 w-24 rounded-lg border border-line object-cover', loading: 'lazy' }),
              ]),
            ),
          )
        : null,
      p.status === 'draft'
        ? el('p', { class: 'text-sm text-muted', text: 'Only you can see this draft. Publish it to open it for votes.' })
        : voteBar(p, {
            busy,
            onVote: (dir) =>
              act(
                () => castVote(p.id, p.viewer.vote, dir),
                (r) => (r.outcome === 'removed' ? 'Vote withdrawn' : r.outcome === 'changed' ? 'Vote changed' : r.outcome === 'cast' ? 'Vote counted' : 'Your vote is unchanged'),
              ),
          }),
      authorMoves.length || p.viewer.canEdit
        ? el('div', { class: 'flex flex-wrap gap-2' }, [
            ...authorMoves.map((to) =>
              button(moveLabel(p.status, to), { onClick: () => act(() => changeStatus(p.id, to), MOVE_TOASTS[to]) }),
            ),
            p.viewer.canEdit
              ? button('Edit', {
                  variant: 'secondary',
                  onClick: () => {
                    surface.dismiss();
                    openProposalForm({
                      meta,
                      proposal: p,
                      onSaved: (saved) => {
                        if (onChanged) onChanged(saved);
                        openProposalDetail({ id: saved.id, meta, onChanged });
                      },
                    });
                  },
                })
              : null,
          ])
        : p.viewer.isAuthor && p.viewer.editBlockedReason
          ? el('p', { class: 'text-xs text-muted', text: p.viewer.editBlockedReason })
          : null,
      reviewerMoves.length
        ? el('div', { class: 'flex flex-col gap-2 border-t border-line pt-3', dataset: { reviewerActions: 'true' } }, [
            el('p', { class: 'text-sm font-medium text-ink', text: 'Review' }),
            el(
              'div',
              { class: 'flex flex-wrap gap-2' },
              reviewerMoves.map((to) =>
                button(moveLabel(p.status, to), {
                  variant: 'secondary',
                  onClick: () => act(() => changeStatus(p.id, to), MOVE_TOASTS[to]),
                }),
              ),
            ),
          ])
        : null,
      p.history && p.history.length
        ? el('div', { class: 'flex flex-col gap-2 border-t border-line pt-3' }, [
            el('p', { class: 'text-sm font-medium text-ink', text: 'History' }),
            el(
              'ol',
              { class: 'flex flex-col gap-1.5', dataset: { history: 'true' } },
              p.history.map((h) =>
                el('li', { class: 'text-xs text-muted' }, [
                  el('span', { class: 'font-medium text-ink', text: h.toLabel }),
                  ` by ${h.actor}, ${timeAgo(h.at)}`,
                ]),
              ),
            ),
          ])
        : null,
      ].filter(Boolean),
    );
  }

  load();
  return surface;
}
