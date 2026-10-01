// One report, presented over the Community screen: what is happening, where,
// the confirm/disagree control, the actions this viewer may take, and the
// status history. Every action re-renders from the server's answer, and the
// feed row is updated through onChanged.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { loading } from '../loading.js';
import { errorState } from '../error-state.js';
import { present } from '../surface.js';
import { timeAgo, toast } from './parts.js';
import { reportIconMarkup } from '../../map/report-icons.js';
import { t, getLocale } from '../../i18n/index.js';
import { formatRelative } from '../../i18n/format.js';
import { getReport, setReportReaction, removeReportReaction, flagReport, changeReportStatus } from '../../services/community.js';

// Pill colours by derived status: verified is the only "good news" state;
// pending, rejected and expired read as neutral grey, the way rejected
// proposals do.
const STATUS_CLASSES = {
  pending: 'bg-surface-raised text-muted',
  verified: 'bg-accent-soft text-accent',
  rejected: 'bg-surface-raised text-muted',
  expired: 'bg-surface-raised text-muted',
};

function statusPill(report) {
  const s = report.effectiveStatus;
  return el('span', {
    class: `inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[s] || STATUS_CLASSES.pending}`,
    text: t(`reports.status.${s}`),
    dataset: { status: s },
  });
}

function reactionButton(value, report, { busy, onReact }) {
  const confirm = value === 'confirm';
  const pressed = report.viewer.reaction === value;
  const count = confirm ? report.reactions.confirm : report.reactions.disagree;
  const label = t(confirm ? 'reports.confirm' : 'reports.disagree');
  const disabled = busy || !report.viewer.canReact;
  return el(
    'button',
    {
      type: 'button',
      class: [
        'inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40',
        pressed ? 'border-transparent bg-accent-soft text-brand' : 'border-line text-muted hover:text-ink',
      ].join(' '),
      'aria-pressed': pressed ? 'true' : 'false',
      'aria-label': `${label} (${count})`,
      title: disabled ? report.viewer.reactBlockedReason || '' : label,
      disabled,
      dataset: { reaction: value },
      onClick: () => onReact(value),
    },
    [
      icon(confirm ? 'check' : 'arrow-down', { class: 'h-4 w-4' }),
      el('span', {
        class: 'tabular-nums',
        text: t(confirm ? 'reports.confirmCount' : 'reports.disagreeCount', { count }),
      }),
    ],
  );
}

// opts: { id, onChanged(report) }
export function openReportDetail({ id, onChanged }) {
  const body = el('div', { class: 'flex flex-col gap-4 p-1', dataset: { reportDetail: id } }, [
    loading({ label: t('reports.loading') }),
  ]);
  const surface = present(body, { label: t('reports.detailTitle') });
  let busy = false;
  let current = null;

  async function load() {
    body.replaceChildren(loading({ label: t('reports.loading') }));
    try {
      render(await getReport(id));
    } catch (err) {
      body.replaceChildren(
        errorState({
          title: err && err.status === 404 ? t('reports.detailTitle') : t('reports.errorTitle'),
          description: (err && err.message) || t('common.tryAgain'),
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
      toast((failure && failure.message) || t('error.somethingWentWrong'), { error: true });
      render(current);
      return;
    }
    if (success) toast(typeof success === 'function' ? success(result) : success);
    // A flag answers without a report to render; everything else carries the
    // fresh copy. The history only comes with reads, so keep the one we have.
    const report = result && result.report ? result.report : result;
    if (report && report.effectiveStatus) {
      render(report.history ? report : { ...report, history: current.history });
      if (onChanged) onChanged(report);
    }
  }

  function onReact(report, value) {
    act(() =>
      report.viewer.reaction === value
        ? removeReportReaction(report.id)
        : setReportReaction(report.id, value),
    );
  }

  function render(r) {
    current = r;
    const expired = r.effectiveStatus === 'expired';
    const locale = getLocale();

    // Optional parts are null; replaceChildren would print them as text.
    body.replaceChildren(
      ...[
        el('div', { class: 'flex flex-wrap items-center gap-2 pr-8' }, [
          statusPill(r),
          el('span', { class: 'inline-flex items-center gap-1.5 text-xs font-medium text-ink' }, [
            el('span', { class: 'shrink-0 text-muted', html: reportIconMarkup(r.type, 'h-3.5 w-3.5') }),
            el('span', { text: t(`reports.type.${r.type}`) }),
          ]),
        ]),
        el('p', { class: 'text-xs text-muted', text: `${t('reports.reportedBy', { username: r.reporter.username })}, ${formatRelative(r.createdAt, { locale })}` }),
        expired
          ? null
          : el('div', { class: 'flex items-center gap-1.5 text-xs text-muted' }, [
              icon('clock', { class: 'h-3.5 w-3.5 shrink-0' }),
              el('span', { text: t('reports.expiresIn', { relativeTime: formatRelative(r.expiresAt, { locale }) }) }),
            ]),
        r.description
          ? el('p', { class: 'whitespace-pre-line text-sm leading-relaxed text-ink', text: r.description })
          : null,
        r.place
          ? el('div', { class: 'flex items-center gap-1.5 text-xs text-muted' }, [
              icon('pin', { class: 'h-3.5 w-3.5 shrink-0' }),
              el('span', { text: `${t('reports.placeRef')} · ${r.place.id}` }),
            ])
          : null,
        el('div', { class: 'flex flex-wrap items-center gap-2', dataset: { reactionControl: r.id } }, [
          reactionButton('confirm', r, { busy, onReact: (value) => onReact(r, value) }),
          reactionButton('disagree', r, { busy, onReact: (value) => onReact(r, value) }),
        ]),
        el('p', { class: 'text-xs text-muted', text: t('reports.reactionHint') }),
        r.viewer.isReporter
          ? el('p', { class: 'text-xs text-muted', text: t('reports.myReportNote') })
          : r.viewer.canFlag
            ? button(t('reports.reportAbuse'), {
                variant: 'ghost',
                class: 'self-start px-0',
                onClick: () => act(() => flagReport(r.id), t('reports.flagToast')),
              })
            : null,
        r.viewer.transitions.length
          ? el('div', { class: 'flex flex-col gap-2 border-t border-line pt-3', dataset: { reviewerActions: 'true' } }, [
              el('p', { class: 'text-sm font-medium text-ink', text: t('reports.review') }),
              el(
                'div',
                { class: 'flex flex-wrap gap-2' },
                r.viewer.transitions.map((to) =>
                  button(t(to === 'verified' ? 'reports.markVerified' : 'reports.markRejected'), {
                    variant: 'secondary',
                    onClick: () => act(() => changeReportStatus(r.id, to), t(to === 'verified' ? 'reports.toastVerified' : 'reports.toastRejected')),
                  }),
                ),
              ),
            ])
          : null,
        r.history && r.history.length
          ? el('div', { class: 'flex flex-col gap-2 border-t border-line pt-3' }, [
              el('p', { class: 'text-sm font-medium text-ink', text: t('reports.history') }),
              el(
                'ol',
                { class: 'flex flex-col gap-1.5', dataset: { history: 'true' } },
                r.history.map((h) =>
                  el('li', { class: 'text-xs text-muted' }, [
                    el('span', { class: 'font-medium text-ink', text: t(`reports.status.${h.to}`) }),
                    ` · ${h.actor} · ${timeAgo(h.at)}`,
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