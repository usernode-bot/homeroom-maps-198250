// Community — the proposal feed. People suggest fixes and additions to the
// map and vote on each other's proposals. Views: Recent, Popular, Nearby,
// Implemented, and Yours (your drafts and published proposals).
//
// The feed's state machine lives in ../services/community-feed.js (pure and
// unit-tested); this screen renders its states and wires the actions. Every
// count comes from the server: a vote updates the row only from the
// proposal the server returns. The chosen view is kept in the hash
// (`#/community?view=popular`) so reload and share keep it, and
// `&proposal=<id>` opens that proposal.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { icon } from '../components/icons.js';
import { loading, spinner } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { placeholderPanel } from '../components/placeholder-panel.js';
import { statusPill, voteColumn, timeAgo, toast } from '../components/community/parts.js';
import { openProposalForm } from '../components/community/proposal-form.js';
import { openProposalDetail } from '../components/community/proposal-detail.js';
import { FEED_VIEWS, isFeedView, createFeed } from '../services/community-feed.js';
import { fetchMeta, listProposals, castVote } from '../services/community.js';
import { locateOnce, lastKnownPosition } from '../services/location.js';
import { hasToken } from '../auth.js';
import * as router from '../router.js';

const EMPTY_COPY = {
  recent: {
    title: 'No proposals yet',
    description: 'Be the first to suggest a fix or an addition to the map.',
  },
  popular: {
    title: 'Nothing to vote on yet',
    description: 'Open proposals appear here, ranked by their votes.',
  },
  nearby: {
    title: 'No proposals near you',
    description: 'Nothing has been proposed within 25 km of your location.',
  },
  implemented: {
    title: 'Nothing implemented yet',
    description: 'Proposals appear here once the change has been made on the map.',
  },
  mine: {
    title: 'You have not proposed anything yet',
    description: 'Your drafts and published proposals appear here.',
  },
};

export async function render(ctx) {
  const params = router.hashParams();
  const initialView = isFeedView(params.get('view')) ? params.get('view') : 'recent';
  const deepProposal = params.get('proposal');

  // Categories and the viewer's role, needed before anything can be created.
  // Loaded after the screen's frame renders; a failure is the feed's error
  // state with Try again, never a blank screen.
  let meta = null;

  const feedHost = el('div', { class: 'flex flex-col gap-3', dataset: { communityFeed: 'true' } });
  const tabs = el('div', {
    class: 'flex gap-1 overflow-x-auto rounded-pill bg-surface-raised p-1',
    role: 'tablist',
    'aria-label': 'Proposal views',
  });
  const busyVotes = new Set();

  const feed = createFeed({
    fetchPage: (view, { offset, near }) => listProposals(view, { offset, near }),
    onChange: () => renderFeed(),
  });

  async function newProposal() {
    if (!meta) {
      try {
        meta = await fetchMeta();
      } catch (err) {
        toast((err && err.message) || 'Proposals are unavailable right now.', { error: true });
        return;
      }
    }
    openProposalForm({
      meta,
      onSaved: (saved, how) => {
        // Drafts live under Yours; a published proposal tops Recent.
        selectView(how === 'draft' ? 'mine' : 'recent');
        openDetail(saved.id);
      },
    });
  }

  function openDetail(id) {
    openProposalDetail({ id, meta, onChanged: (p) => feed.replace(p) });
  }

  async function vote(p, direction) {
    if (busyVotes.has(p.id)) return;
    busyVotes.add(p.id);
    renderFeed();
    try {
      const { proposal } = await castVote(p.id, p.viewer.vote, direction);
      busyVotes.delete(p.id);
      feed.replace(proposal);
    } catch (err) {
      busyVotes.delete(p.id);
      renderFeed();
      toast((err && err.message) || 'Your vote could not be saved. Please try again.', { error: true });
    }
  }

  async function useLocation() {
    const pos = await locateOnce();
    if (!pos.ok) {
      toast(pos.message, { error: !pos.pending });
      return;
    }
    feed.load('nearby', { near: { lat: pos.lat, lng: pos.lng } });
  }

  function selectView(view) {
    router.replaceHashParams(view === 'recent' ? {} : { view });
    renderTabs(view);
    if (!meta) return;
    if (view === 'nearby') {
      const pos = lastKnownPosition();
      if (pos) feed.load('nearby', { near: { lat: pos.lat, lng: pos.lng } });
      else feed.needLocation('nearby');
    } else {
      feed.load(view);
    }
  }

  function renderTabs(active) {
    tabs.replaceChildren(
      ...FEED_VIEWS.map((v) => {
        const on = v.id === active;
        return el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          class: [
            'shrink-0 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            on ? 'bg-surface text-ink' : 'text-muted hover:text-ink',
          ].join(' '),
          dataset: { feedView: v.id },
          text: v.label,
          onClick: () => {
            if (!on) selectView(v.id);
          },
        });
      }),
    );
  }

  function row(p, view) {
    const where = p.location
      ? `${p.location.name}${p.distanceKm != null ? ` (${p.distanceKm} km)` : ''}`
      : 'Whole map';
    const when =
      view === 'implemented'
        ? `implemented ${timeAgo(p.statusChangedAt)}`
        : p.status === 'draft'
          ? `edited ${timeAgo(p.updatedAt)}`
          : timeAgo(p.publishedAt);
    return el('li', { class: 'flex gap-2 px-2 py-3', dataset: { proposalRow: p.id } }, [
      p.status === 'draft'
        ? el('div', { class: 'w-10 shrink-0' })
        : voteColumn(p, { busy: busyVotes.has(p.id), onVote: (dir) => vote(p, dir) }),
      el(
        'button',
        {
          type: 'button',
          class: 'flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          onClick: () => openDetail(p.id),
        },
        [
          el('span', { class: 'flex flex-wrap items-center gap-2' }, [
            statusPill(p),
            el('span', { class: 'text-xs text-muted', text: p.categoryLabel }),
          ]),
          el('span', { class: 'text-sm font-semibold leading-snug text-ink', text: p.title }),
          el('span', { class: 'flex min-w-0 items-center gap-1 text-xs text-muted' }, [
            icon('pin', { class: 'h-3.5 w-3.5 shrink-0' }),
            el('span', { class: 'truncate', text: `${where} · ${p.author.username} · ${when}` }),
          ]),
        ],
      ),
    ]);
  }

  function renderFeed() {
    const s = feed.getState();
    feedHost.dataset.feedState = s.status;
    feedHost.dataset.feedView = s.view;
    if (s.status === 'loading' || s.status === 'idle') {
      feedHost.replaceChildren(loading({ label: 'Loading proposals' }));
      return;
    }
    if (s.status === 'error') {
      feedHost.replaceChildren(
        errorState({
          title: 'Proposals could not load',
          description: (s.error && s.error.message) || 'Please try again.',
          onRetry: () => feed.retry(),
        }),
      );
      return;
    }
    if (s.status === 'needs_location') {
      feedHost.replaceChildren(
        emptyState({
          title: 'See proposals near you',
          description: 'Share your location to list proposals within 25 km of where you are.',
          action: button('Use my location', { variant: 'secondary', onClick: useLocation }),
        }),
      );
      return;
    }
    if (s.status === 'empty') {
      const copy = EMPTY_COPY[s.view] || EMPTY_COPY.recent;
      feedHost.replaceChildren(
        emptyState({
          title: copy.title,
          description: copy.description,
          action: button('New proposal', { variant: 'secondary', onClick: newProposal }),
        }),
      );
      return;
    }
    const footer = s.loadingMore
      ? el('div', { class: 'flex justify-center py-2' }, [spinner()])
      : s.moreError
        ? errorState({
            title: 'More proposals could not load',
            description: s.moreError.message,
            onRetry: () => feed.loadMore(),
          })
        : s.hasMore
          ? button('Show more', { variant: 'secondary', class: 'self-center', onClick: () => feed.loadMore() })
          : null;
    feedHost.replaceChildren(
      el(
        'ul',
        { class: 'divide-y divide-line rounded-card border border-line bg-surface' },
        s.items.map((p) => row(p, s.view)),
      ),
      ...(footer ? [footer] : []),
    );
  }

  const newButton = button('New proposal', {
    onClick: newProposal,
    attrs: { 'data-new-proposal': 'true' },
  });

  ctx.content.replaceChildren(
    el('div', { class: 'flex items-center justify-between gap-3' }, [
      el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: 'Community' }),
      newButton,
    ]),
    el('p', {
      class: 'text-sm text-muted leading-relaxed',
      text: 'Proposals are suggested fixes and additions to the map. Vote on the ones you know about.',
    }),
    tabs,
    feedHost,
    placeholderPanel({
      title: 'Reports and discussions',
      description: 'Reporting problems and talking changes through with the community are coming soon.',
    }),
  );

  renderTabs(initialView);
  if (!hasToken()) {
    // Opened outside Homeroom (or offline): there is nobody to propose or
    // vote as, and the API would rightly refuse. Say so instead of asking.
    newButton.disabled = true;
    feedHost.dataset.feedState = 'signed_out';
    feedHost.replaceChildren(
      emptyState({
        title: 'Open Homeroom Maps inside Homeroom',
        description: 'Proposals and voting need your Homeroom sign-in.',
      }),
    );
    return;
  }

  async function start() {
    feedHost.dataset.feedState = 'loading';
    feedHost.replaceChildren(loading({ label: 'Loading proposals' }));
    try {
      meta = await fetchMeta();
    } catch (err) {
      feedHost.dataset.feedState = 'error';
      feedHost.replaceChildren(
        errorState({
          title: 'Proposals could not load',
          description: (err && err.message) || 'Please try again.',
          onRetry: start,
        }),
      );
      return;
    }
    selectView(initialView);
    if (deepProposal && /^\d+$/.test(deepProposal)) openDetail(deepProposal);
  }
  await start();
}
