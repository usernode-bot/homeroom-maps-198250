// Business — the dashboard for a person's claims and verified businesses,
// plus the review queue for business reviewers (Phase 12J).
//
// The chosen view is kept in the hash (`#/business?view=queue`) so reload and
// share keep it. Everyone sees their own claims and businesses; the queue is
// reachable only by a configured business reviewer, and the URL says so
// honestly to everyone else rather than pretending.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { loading, spinner } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { statusChip, timeAgo, toast } from '../components/business/status-chip.js';
import { createEditForm } from '../components/business/edit-form.js';
import { t } from '../i18n/index.js';
import { hasToken } from '../auth.js';
import * as router from '../router.js';
import {
  fetchMeta,
  listMine,
  fetchQueue,
  withdrawClaim,
  decideClaim,
} from '../services/business.js';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

const REASONS = [
  'insufficient_evidence',
  'not_your_business',
  'duplicate_place',
  'contact_unreachable',
  'abuse',
];

export async function render(ctx) {
  const params = router.hashParams();
  const queueRequested = params.get('view') === 'queue';

  const header = el('div', { class: 'flex items-center justify-between gap-3' }, [
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('business.dashboardTitle') }),
  ]);
  const host = el('div', { class: 'flex flex-col gap-4', dataset: { businessHost: 'true' } });

  ctx.content.replaceChildren(header, host);

  if (!hasToken()) {
    host.replaceChildren(
      emptyState({
        title: t('business.signedOutTitle'),
        description: t('business.signedOutBody'),
      }),
    );
    return;
  }

  host.replaceChildren(loading({ label: t('business.loading') }));

  let meta = null;
  let mine = null;
  try {
    [meta, mine] = await Promise.all([fetchMeta(), listMine()]);
  } catch (err) {
    host.replaceChildren(
      errorState({
        title: t('business.loadError'),
        description: (err && err.message) || t('common.tryAgain'),
        onRetry: () => render(ctx),
      }),
    );
    return;
  }

  const isReviewer = Boolean(meta && meta.viewer && meta.viewer.reviewer);

  const parts = [];
  parts.push(el('p', { class: 'text-sm text-muted leading-relaxed', text: t('business.intro') }));

  // Reviewer queue first: a reviewer's waiting work outranks their own list.
  if (isReviewer) {
    parts.push(queueSection());
  } else if (queueRequested) {
    parts.push(
      el('p', {
        class: 'rounded-card border border-dashed border-line bg-surface/60 px-4 py-3 text-sm text-muted leading-relaxed',
        text: t('business.queueForbidden'),
      }),
    );
  }

  parts.push(myBusinessesSection(mine.profiles || []));
  parts.push(myClaimsSection(mine.claims || []));

  host.replaceChildren(...parts);

  // ── my businesses ────────────────────────────────────────────────────────

  function myBusinessesSection(profiles) {
    const section = el('section', { class: 'flex flex-col gap-2', dataset: { businessMine: 'true' } }, [
      el('p', { class: 'text-base font-semibold text-ink', text: t('business.myBusinesses') }),
    ]);
    if (!profiles.length) {
      section.appendChild(
        emptyState({
          title: t('business.noBusinessesTitle'),
          description: t('business.noBusinessesBody'),
        }),
      );
      return section;
    }
    const list = el('ul', { class: 'divide-y divide-line rounded-card border border-line bg-surface' });
    for (const profile of profiles) {
      list.appendChild(profileRow(profile));
    }
    section.appendChild(list);
    return section;
  }

  function profileRow(profile) {
    const row = el('li', { class: 'flex flex-col gap-2 px-3 py-3', dataset: { businessProfileRow: profile.id } });
    row.appendChild(
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        statusChip(profile.status, profile.statusLabel),
        el('span', { class: 'text-sm font-semibold text-ink', text: profile.name }),
      ]),
    );
    if (profile.address) {
      row.appendChild(el('p', { class: 'text-xs text-muted', text: profile.address }));
    }
    if (profile.viewer && profile.viewer.canEdit) {
      const editBtn = button(t('business.editProfile'), {
        variant: 'secondary',
        class: 'self-start',
        attrs: { 'data-business-edit': 'true' },
      });
      const slot = el('div', { class: 'flex flex-col gap-2' }, [editBtn]);
      row.appendChild(slot);
      editBtn.addEventListener('click', () => {
        if (slot.querySelector('[data-business-edit-form]')) return;
        const form = createEditForm({
          profile,
          onSaved: (updated) => {
            slot.replaceChildren(
              el('p', { class: 'text-xs text-muted', text: t('business.savedToast') }),
            );
            // Refresh the row's chip and name in place.
            const chip = row.querySelector('[data-status-chip]');
            if (chip) chip.textContent = updated.statusLabel;
          },
        });
        form.setCancel(() => slot.replaceChildren(editBtn));
        slot.replaceChildren(form.root);
      });
    }
    return row;
  }

  // ── my claims ────────────────────────────────────────────────────────────

  function myClaimsSection(claims) {
    const section = el('section', { class: 'flex flex-col gap-2', dataset: { businessClaims: 'true' } }, [
      el('p', { class: 'text-base font-semibold text-ink', text: t('business.myClaims') }),
    ]);
    if (!claims.length) {
      section.appendChild(
        emptyState({
          title: t('business.noClaimsTitle'),
          description: t('business.noClaimsBody'),
        }),
      );
      return section;
    }
    const list = el('ul', { class: 'divide-y divide-line rounded-card border border-line bg-surface' });
    for (const claim of claims) {
      list.appendChild(claimRow(claim));
    }
    section.appendChild(list);
    return section;
  }

  function claimRow(claim) {
    const row = el('li', { class: 'flex flex-col gap-2 px-3 py-3', dataset: { businessClaimRow: claim.id } });
    row.appendChild(
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        statusChip(claim.status, claim.statusLabel),
        el('span', { class: 'min-w-0 truncate text-sm font-semibold text-ink', text: claim.place.name }),
      ]),
    );
    const meta = [];
    if (claim.status === 'pending' && claim.daysLeft != null) {
      meta.push(t('business.pendingDays', { days: claim.daysLeft }));
    }
    meta.push(timeAgo(claim.createdAt));
    row.appendChild(el('p', { class: 'text-xs text-muted', text: meta.join(' · ') }));
    if (claim.status === 'rejected' && claim.decisionReason) {
      row.appendChild(
        el('p', {
          class: 'text-sm text-muted leading-relaxed',
          text: t(`business.rejectReason.${claim.decisionReason}`),
        }),
      );
    }
    if (claim.viewer && claim.viewer.canWithdraw) {
      const withdrawBtn = button(t('business.withdraw'), {
        variant: 'secondary',
        class: 'self-start',
        attrs: { 'data-business-withdraw': 'true' },
        onClick: async () => {
          withdrawBtn.disabled = true;
          try {
            await withdrawClaim(claim.id);
            const fresh = await listMine();
            host.replaceChildren(...buildParts(fresh));
          } catch (err) {
            withdrawBtn.disabled = false;
            toast((err && err.message) || t('business.actionFailed'), { error: true });
          }
        },
      });
      row.appendChild(withdrawBtn);
    }
    return row;
  }

  function buildParts(fresh) {
    const list = [];
    list.push(el('p', { class: 'text-sm text-muted leading-relaxed', text: t('business.intro') }));
    if (isReviewer) list.push(queueSection());
    list.push(myBusinessesSection(fresh.profiles || []));
    list.push(myClaimsSection(fresh.claims || []));
    return list;
  }

  // ── the review queue (reviewers only) ────────────────────────────────────

  function queueSection() {
    const section = el('section', { class: 'flex flex-col gap-2', dataset: { businessQueue: 'true' } }, [
      el('p', { class: 'text-base font-semibold text-ink', text: t('business.queueTitle') }),
    ]);
    const tabs = el('div', {
      class: 'flex gap-1 self-start rounded-pill bg-surface-raised p-1',
      role: 'tablist',
      'aria-label': t('business.queueTitle'),
    });
    const listHost = el('div', { class: 'flex flex-col gap-2', dataset: { queueList: 'true' } });
    section.appendChild(tabs);
    section.appendChild(listHost);

    let view = 'pending';
    let offset = 0;
    let items = [];

    const VIEWS = [
      { id: 'pending', label: () => t('business.queuePending') },
      { id: 'superseded', label: () => t('business.queueSuperseded') },
    ];

    function renderTabs() {
      tabs.replaceChildren(
        ...VIEWS.map((v) => {
          const on = v.id === view;
          return el('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': on ? 'true' : 'false',
            class: [
              'rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              on ? 'bg-surface text-ink' : 'text-muted hover:text-ink',
            ].join(' '),
            text: v.label(),
            onClick: () => {
              if (!on) load(v.id);
            },
          });
        }),
      );
    }

    async function load(nextView) {
      view = nextView;
      offset = 0;
      renderTabs();
      listHost.replaceChildren(el('div', { class: 'flex items-center gap-3', role: 'status' }, [
        spinner(),
        el('p', { class: 'text-sm text-muted', text: t('business.queueLoading') }),
      ]));
      try {
        const page = await fetchQueue({ view, offset });
        items = page.items || [];
        offset = page.nextOffset == null ? null : page.nextOffset;
        renderList();
      } catch (err) {
        listHost.replaceChildren(
          errorState({
            title: t('business.queueError'),
            description: (err && err.message) || t('common.tryAgain'),
            onRetry: () => load(view),
          }),
        );
      }
    }

    function renderList() {
      if (!items.length) {
        listHost.replaceChildren(
          emptyState({
            title: t(view === 'superseded' ? 'business.queueSupersededEmptyTitle' : 'business.queueEmptyTitle'),
            description: t('business.queueEmptyBody'),
          }),
        );
        return;
      }
      const list = el('ul', { class: 'divide-y divide-line rounded-card border border-line bg-surface' });
      for (const claim of items) {
        list.appendChild(queueRow(claim));
      }
      const more =
        offset != null
          ? button(t('business.showMore'), { variant: 'secondary', class: 'self-center', onClick: async () => {
              try {
                const page = await fetchQueue({ view, offset });
                items = items.concat(page.items || []);
                offset = page.nextOffset == null ? null : page.nextOffset;
                renderList();
              } catch (err) {
                toast((err && err.message) || t('business.queueError'), { error: true });
              }
            } })
          : null;
      listHost.replaceChildren(list, ...(more ? [more] : []));
    }

    function queueRow(claim) {
      const row = el('li', { class: 'flex flex-col gap-2 px-3 py-3', dataset: { queueRow: claim.id } });
      row.appendChild(
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          statusChip(claim.status, claim.statusLabel),
          el('span', { class: 'min-w-0 truncate text-sm font-semibold text-ink', text: claim.place.name }),
        ]),
      );
      row.appendChild(
        el('p', { class: 'text-xs text-muted', text: t('business.claimedBy', { username: claim.claimant.username }) }),
      );
      // The reviewer sees what the decision needs: the contact value and the
      // evidence links. This is the only surface that ever shows them.
      row.appendChild(
        el('p', { class: 'break-words text-sm text-ink', text: claim.contactValue }),
      );
      if (Array.isArray(claim.evidence) && claim.evidence.length) {
        const thumbs = el('div', { class: 'flex flex-wrap gap-2' });
        for (const ev of claim.evidence) {
          thumbs.appendChild(
            el('img', {
              src: ev.url,
              alt: ev.filename || 'Evidence photo',
              class: 'h-16 w-16 rounded-lg border border-line object-cover',
            }),
          );
        }
        row.appendChild(thumbs);
      }
      if (claim.status === 'pending' && claim.daysLeft != null) {
        row.appendChild(el('p', { class: 'text-xs text-muted', text: t('business.pendingDays', { days: claim.daysLeft }) }));
      }
      row.appendChild(decisionControls(claim));
      return row;
    }

    function decisionControls(claim) {
      let open = false;
      const slot = el('div', { class: 'flex flex-wrap gap-2' }, [
        button(t('business.verify'), {
          attrs: { 'data-queue-verify': 'true' },
          onClick: () => decide(claim, 'verified'),
        }),
        button(t('business.reject'), {
          variant: 'secondary',
          attrs: { 'data-queue-reject': 'true' },
          onClick: () => {
            if (open) return;
            open = true;
            slot.replaceChildren(rejectForm(claim));
          },
        }),
      ]);
      return slot;
    }

    function rejectForm(claim) {
      const select = el('select', { class: INPUT, dataset: { rejectReason: 'true' } }, [
        el('option', { value: '', text: t('business.chooseReason') }),
        ...REASONS.map((r) => el('option', { value: r, text: t(`business.rejectReason.${r}`) })),
      ]);
      const note = el('input', { class: INPUT, placeholder: t('business.decisionNotePlaceholder') });
      const send = button(t('business.reject'), {
        onClick: async () => {
          send.disabled = true;
          await decide(claim, 'rejected', { reason: select.value, note: note.value });
          send.disabled = false;
        },
      });
      const back = button(t('common.cancel'), { variant: 'secondary', onClick: () => renderList() });
      return el('div', { class: 'flex w-full flex-col gap-2 rounded-card border border-line bg-surface p-3', dataset: { rejectForm: 'true' } }, [
        select,
        note,
        el('div', { class: 'flex flex-wrap gap-2' }, [send, back]),
      ]);
    }

    async function decide(claim, status, extra = {}) {
      try {
        await decideClaim(claim.id, { status, ...extra });
        toast(status === 'verified' ? t('business.toastVerified') : t('business.toastRejected'));
        const page = await fetchQueue({ view, offset: 0 });
        items = page.items || [];
        offset = page.nextOffset == null ? null : page.nextOffset;
        renderList();
      } catch (err) {
        toast((err && err.message) || t('business.actionFailed'), { error: true });
      }
    }

    load(view);
    return section;
  }
}
