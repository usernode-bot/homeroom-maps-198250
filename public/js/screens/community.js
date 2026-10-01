// Community — proposals and reports. People suggest fixes and additions to
// the map and vote on each other's proposals, and report what is happening
// on the ground right now: traffic, hazards, closures — each with its own
// expiry window.
//
// Both feeds share the state machine in ../services/community-feed.js (pure
// and unit-tested); this screen renders their states and wires the actions.
// Every count comes from the server: a vote or a reaction updates the row
// only from the answer the server returns. The chosen view is kept in the
// hash (`#/community?view=popular`, `#/community?view=reports&filter=mine`)
// so reload and share keep it, and `&proposal=<id>` / `&report=<id>` open
// that one item.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { icon } from '../components/icons.js';
import { loading, spinner } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { statusPill, voteColumn, timeAgo, toast } from '../components/community/parts.js';
import { openProposalForm } from '../components/community/proposal-form.js';
import { openProposalDetail } from '../components/community/proposal-detail.js';
import { openReportForm } from '../components/community/report-form.js';
import { openReportDetail } from '../components/community/report-detail.js';
import { reportIconMarkup } from '../map/report-icons.js';
import { FEED_VIEWS, isFeedView, createFeed } from '../services/community-feed.js';
import {
  fetchMeta,
  fetchReportsMeta,
  listProposals,
  listReports,
  castVote,
} from '../services/community.js';
import { locateOnce, lastKnownPosition } from '../services/location.js';
import { t, getLocale } from '../i18n/index.js';
import { formatRelative, formatDistance } from '../i18n/format.js';
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

// The reports feed's views, in display order. IDs match the API.
const REPORT_FILTERS = ['recent', 'nearby', 'mine'];

// Pill colours for a report's derived status. Verified is the only "good
// news" state; pending, rejected and expired read as neutral grey, the way
// rejected proposals do.
const REPORT_STATUS_CLASSES = {
  pending: 'bg-surface-raised text-muted',
  verified: 'bg-accent-soft text-accent',
  rejected: 'bg-surface-raised text-muted',
  expired: 'bg-surface-raised text-muted',
};

function reportStatusPill(report) {
  const s = report.effectiveStatus;
  return el('span', {
    class: `inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-xs font-medium ${REPORT_STATUS_CLASSES[s] || REPORT_STATUS_CLASSES.pending}`,
    text: t(`reports.status.${s}`),
    dataset: { status: s },
  });
}

export async function render(ctx) {
  const params = router.hashParams();
  const reportsMode = params.get('view') === 'reports';
  const initialView = isFeedView(params.get('view')) ? params.get('view') : 'recent';
  const initialFilter = REPORT_FILTERS.includes(params.get('filter')) ? params.get('filter') : 'recent';
  const deepProposal = params.get('proposal');
  const deepReport = params.get('report');

  // Categories and the viewer's role, needed before anything can be created.
  // Loaded after the screen's frame renders; a failure is the feed's error
  // state with Try again, never a blank screen.
  let meta = null;
  let mode = reportsMode ? 'reports' : 'proposals';
  let reportMeta = null;

  const feedHost = el('div', { class: 'flex flex-col gap-3', dataset: { communityFeed: 'true' } });
  const reportsHost = el('div', { class: 'flex flex-col gap-3', dataset: { reportsFeed: 'true' } });
  const tabs = el('div', {
    class: 'flex gap-1 overflow-x-auto rounded-pill bg-surface-raised p-1',
    role: 'tablist',
    'aria-label': 'Proposal views',
  });
  const reportTabs = el('div', {
    class: 'flex gap-1 overflow-x-auto rounded-pill bg-surface-raised p-1',
    role: 'tablist',
    'aria-label': 'Report views',
  });
  const intro = el('p', {
    class: 'text-sm text-muted leading-relaxed',
    text: 'Proposals are suggested fixes and additions to the map. Vote on the ones you know about.',
  });
  const header = el('div', { class: 'flex items-center justify-between gap-3' });
  const busyVotes = new Set();

  const feed = createFeed({
    fetchPage: (view, { offset, near }) => listProposals(view, { offset, near }),
    onChange: () => renderFeed(),
  });

  const reportsFeed = createFeed({
    fetchPage: (view, { offset, near }) => listReports(view, { offset, near }),
    onChange: () => renderReportsFeed(),
  });

  // ── shared chrome: header, intro, tab row ────────────────────────────────

  const signedOut = !hasToken();

  function renderHeader() {
    const primary =
      mode === 'reports'
        ? button(t('reports.report'), { onClick: newReport, attrs: { 'data-new-report': 'true' } })
        : button('New proposal', { onClick: newProposal, attrs: { 'data-new-proposal': 'true' } });
    if (signedOut) primary.disabled = true;
    header.replaceChildren(el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('nav.community') }), primary);
  }

  function renderTabs(active) {
    const entries = [
      ...FEED_VIEWS.map((v) => ({ id: v.id, label: v.label })),
      { id: 'reports', label: t('reports.tab') },
    ];
    tabs.replaceChildren(
      ...entries.map((v) => {
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

  function renderReportTabs(active) {
    reportTabs.replaceChildren(
      ...REPORT_FILTERS.map((v) => {
        const on = v === active;
        return el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          class: [
            'shrink-0 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            on ? 'bg-surface text-ink' : 'text-muted hover:text-ink',
          ].join(' '),
          dataset: { feedView: v },
          text: t(`reports.filter.${v}`),
          onClick: () => {
            if (!on) selectFilter(v);
          },
        });
      }),
    );
  }

  function showMode() {
    intro.classList.toggle('hidden', mode === 'reports');
    reportTabs.classList.toggle('hidden', mode !== 'reports');
    feedHost.classList.toggle('hidden', mode === 'reports');
    reportsHost.classList.toggle('hidden', mode !== 'reports');
    renderHeader();
    renderTabs(mode === 'reports' ? 'reports' : feed.getState().view);
    if (mode === 'reports') renderReportTabs(reportsFeed.getState().view);
  }

  // ── proposals (Phase 5) ──────────────────────────────────────────────────

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
    if (mode === 'reports') return; // hidden; it keeps its state for the way back
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

  // ── reports (Phase 6) ────────────────────────────────────────────────────

  async function newReport() {
    if (!reportMeta) {
      try {
        reportMeta = await fetchReportsMeta();
      } catch (err) {
        toast((err && err.message) || t('reports.errorTitle'), { error: true });
        return;
      }
    }
    openReportForm({
      meta: reportMeta,
      onSaved: (saved) => {
        // A fresh report tops Recent (and Mine); open it so the person sees
        // what the community will see.
        selectFilter('recent');
        openReportDetailView(saved.id);
      },
    });
  }

  function openReportDetailView(id) {
    openReportDetail({ id, onChanged: (r) => reportsFeed.replace(r) });
  }

  async function useLocationForReports() {
    const pos = await locateOnce();
    if (!pos.ok) {
      toast(pos.message, { error: !pos.pending });
      return;
    }
    reportsFeed.load('nearby', { near: { lat: pos.lat, lng: pos.lng } });
  }

  function selectFilter(view) {
    router.replaceHashParams({ view: 'reports', ...(view === 'recent' ? {} : { filter: view }) });
    renderReportTabs(view);
    if (view === 'nearby') {
      const pos = lastKnownPosition();
      if (pos) reportsFeed.load('nearby', { near: { lat: pos.lat, lng: pos.lng } });
      else reportsFeed.needLocation('nearby');
    } else {
      reportsFeed.load(view);
    }
  }

  function reportRow(r) {
    const locale = getLocale();
    const when = formatRelative(r.createdAt, { locale });
    const where =
      r.distanceKm != null
        ? ` · ${formatDistance(r.distanceKm * 1000, { locale })}`
        : '';
    return el('li', { class: 'flex gap-3 px-2 py-3', dataset: { reportRow: r.id } }, [
      el(
        'button',
        {
          type: 'button',
          class: 'flex min-w-0 flex-1 items-start gap-3 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          onClick: () => openReportDetailView(r.id),
        },
        [
          el('span', {
            class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-brand',
            html: reportIconMarkup(r.type, 'h-5 w-5'),
          }),
          el('span', { class: 'flex min-w-0 flex-1 flex-col gap-1' }, [
            el('span', { class: 'flex flex-wrap items-center gap-2' }, [
              reportStatusPill(r),
              el('span', { class: 'text-xs text-muted', text: t(`reports.type.${r.type}`) }),
            ]),
            r.description
              ? el('span', { class: 'line-clamp-2 text-sm leading-snug text-ink', text: r.description })
              : null,
            el('span', { class: 'flex min-w-0 items-center gap-1 text-xs text-muted' }, [
              el('span', { class: 'truncate', text: `${r.reporter.username} · ${when}${where}` }),
            ]),
          ]),
        ],
      ),
    ]);
  }

  function renderReportsFeed() {
    const s = reportsFeed.getState();
    reportsHost.dataset.feedState = s.status;
    reportsHost.dataset.feedView = s.view;
    if (mode !== 'reports') return; // hidden; it keeps its state for the way back
    if (s.status === 'loading' || s.status === 'idle') {
      reportsHost.replaceChildren(loading({ label: t('reports.loading') }));
      return;
    }
    if (s.status === 'error') {
      reportsHost.replaceChildren(
        errorState({
          title: t('reports.errorTitle'),
          description: (s.error && s.error.message) || t('common.tryAgain'),
          onRetry: () => reportsFeed.retry(),
        }),
      );
      return;
    }
    if (s.status === 'needs_location') {
      reportsHost.replaceChildren(
        emptyState({
          title: t('reports.needLocation.title'),
          description: t('reports.needLocation.body'),
          action: button(t('reports.useMyLocation'), { variant: 'secondary', onClick: useLocationForReports }),
        }),
      );
      return;
    }
    if (s.status === 'empty') {
      reportsHost.replaceChildren(
        emptyState({
          title: t(`reports.empty.${s.view}.title`),
          description: t(`reports.empty.${s.view}.body`),
          action: button(t('reports.report'), { variant: 'secondary', onClick: newReport }),
        }),
      );
      return;
    }
    const footer = s.loadingMore
      ? el('div', { class: 'flex justify-center py-2' }, [spinner()])
      : s.moreError
        ? errorState({
            title: t('reports.errorTitle'),
            description: s.moreError.message,
            onRetry: () => reportsFeed.loadMore(),
          })
        : s.hasMore
          ? button(t('reports.showMore'), { variant: 'secondary', class: 'self-center', onClick: () => reportsFeed.loadMore() })
          : null;
    reportsHost.replaceChildren(
      el(
        'ul',
        { class: 'divide-y divide-line rounded-card border border-line bg-surface' },
        s.items.map((r) => reportRow(r)),
      ),
      ...(footer ? [footer] : []),
    );
  }

  // ── view selection ───────────────────────────────────────────────────────

  async function selectView(view) {
    if (view === 'reports') {
      mode = 'reports';
      showMode();
      // The first entry loads; coming back keeps whatever the feed showed.
      if (reportsFeed.getState().status === 'idle') selectFilter('recent');
      return;
    }
    mode = 'proposals';
    router.replaceHashParams(view === 'recent' ? {} : { view });
    showMode();
    if (!(await ensureMeta())) return;
    if (view === 'nearby') {
      const pos = lastKnownPosition();
      if (pos) feed.load('nearby', { near: { lat: pos.lat, lng: pos.lng } });
      else feed.needLocation('nearby');
    } else {
      feed.load(view);
    }
  }

  async function ensureMeta() {
    if (meta) return true;
    try {
      meta = await fetchMeta();
      return true;
    } catch (err) {
      feedHost.dataset.feedState = 'error';
      feedHost.replaceChildren(
        errorState({
          title: 'Proposals could not load',
          description: (err && err.message) || 'Please try again.',
          onRetry: () => selectView(feed.getState().view || 'recent'),
        }),
      );
      return false;
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

  ctx.content.replaceChildren(header, intro, tabs, reportTabs, feedHost, reportsHost);

  showMode();
  if (signedOut) {
    // Opened outside Homeroom (or offline): there is nobody to propose, vote,
    // report or react as, and the API would rightly refuse. Say so instead of
    // asking.
    feedHost.dataset.feedState = 'signed_out';
    reportsHost.dataset.feedState = 'signed_out';
    feedHost.replaceChildren(
      emptyState({
        title: 'Open Homeroom Maps inside Homeroom',
        description: 'Proposals and voting need your Homeroom sign-in.',
      }),
    );
    reportsHost.replaceChildren(
      emptyState({
        title: t('reports.signedOutTitle'),
        description: t('reports.signedOutBody'),
      }),
    );
    return;
  }

  async function start() {
    if (mode === 'reports') {
      selectFilter(initialFilter);
      if (deepReport && /^\d+$/.test(deepReport)) openReportDetailView(deepReport);
      return;
    }
    if (!(await ensureMeta())) return;
    selectView(initialView);
    if (deepProposal && /^\d+$/.test(deepProposal)) openDetail(deepProposal);
  }

  await start();
}