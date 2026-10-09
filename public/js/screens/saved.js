// Saved places — the screen behind the Saved tab. Three modes, all driven by
// the fragment's query so every surface is deep-linkable and back/forward
// safe:
//
//   #/saved                    Your lists + Public (pill tabs)
//   #/saved?list=<id>          one list: header, owner actions, items
//   #/saved?list=<id>&item=<id>  one place in the list: note + comments
//
// `&key=<share token>` rides along on Shared-list deep links; it is passed to
// the read calls and never stored. Every number on screen comes from the
// server (services/saved.js); empty and failed fetches render the shared
// states, never placeholders.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { card } from '../components/card.js';
import { loading } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { toast } from '../components/community/parts.js';
import { emojiBadge, visibilityPill, visibilityNote, confirmableButton } from '../components/saved/parts.js';
import { openListForm } from '../components/saved/list-form.js';
import { openPlaceSheet } from '../components/saved/place-sheet.js';
import { openListPicker } from '../components/saved/list-picker.js';
import { createItemDetailView } from '../components/saved/item-detail.js';
import * as saved from '../services/saved.js';
import * as router from '../router.js';
import { hasToken } from '../auth.js';
import { t } from '../i18n/index.js';

const PAGE_LIMIT = 20;

export async function render(ctx) {
  const params = router.hashParams();
  const listId = params.get('list');
  const itemId = params.get('item');
  const key = params.get('key') || null;
  const view = params.get('view') === 'public' ? 'public' : 'mine';

  const host = el('div', { class: 'flex flex-col gap-4', dataset: { savedScreen: 'true' } });
  ctx.content.replaceChildren(host);

  // Signed out (standalone, offline, no platform token): say so plainly.
  // The lists live server-side, so there is nothing to show without one.
  if (!hasToken()) {
    host.replaceChildren(
      el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('saved.title') }),
      emptyState({
        title: t('saved.signedOutTitle'),
        description: t('saved.signedOutBody'),
      }),
    );
    return;
  }

  if (listId) {
    await showList({ listId, itemId, key, view });
    return;
  }
  showViews({ view });

  // ---- navigation ----

  function go(next) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v != null && v !== '') q.set(k, String(v));
    }
    const hash = '#/saved' + (q.toString() ? '?' + q.toString() : '');
    if (window.location.hash === hash) {
      render(ctx); // same fragment: hashchange will not fire, re-render here
      return;
    }
    window.location.hash = hash;
  }

  // ---- views mode (tabs) ----

  function showViews({ view: currentView }) {
    const tabs = el('div', {
      class: 'flex gap-1 rounded-pill bg-surface-raised p-1',
      role: 'group',
      'aria-label': t('saved.tabGroup'),
      dataset: { savedTabs: 'true' },
    });
    for (const v of ['mine', 'public']) {
      const active = v === currentView;
      const tab = el('button', {
        type: 'button',
        class: [
          'flex-1 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          active ? 'bg-brand text-brand-contrast' : 'text-muted hover:text-ink',
        ].join(' '),
        'aria-pressed': active ? 'true' : 'false',
        dataset: { savedTab: v },
        onClick: () => go({ view: v }),
      }, [t(v === 'mine' ? 'saved.tabMine' : 'saved.tabPublic')]);
      tabs.appendChild(tab);
    }

    const listHost = el('div', { class: 'flex flex-col gap-2', dataset: { savedListHost: 'true' } });
    const newBtn = button(t('saved.newList'), {
      variant: 'secondary',
      attrs: { dataset: { savedNewList: 'true' } },
      onClick: () => openListForm({
        onSaved: (created) => {
          toast(t('saved.listCreated'));
          go({ list: created.id, view: currentView });
        },
      }),
    });

    host.replaceChildren(
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('saved.title') }),
        currentView === 'mine' ? newBtn : null,
      ]),
      tabs,
      listHost,
    );

    if (currentView === 'mine') showMine(listHost);
    else showPublic(listHost);
  }

  function listRow(cardData, { onClick, owner = false } = {}) {
    const meta = [t('saved.placeCount').replace('{count}', String(cardData.itemCount))];
    if (owner && cardData.pendingSuggestions > 0) {
      meta.push(t('saved.suggestionCount').replace('{count}', String(cardData.pendingSuggestions)));
    }
    return el('button', {
      type: 'button',
      class:
        'flex w-full items-center gap-3 rounded-card border border-line bg-surface p-4 text-left shadow-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      dataset: { savedListRow: cardData.id },
      onClick,
    }, [
      emojiBadge(cardData.emoji),
      el('span', { class: 'min-w-0 flex-1' }, [
        el('span', { class: 'block truncate text-base font-semibold text-ink', text: cardData.name }),
        owner
          ? el('span', { class: 'block truncate text-sm text-muted', text: meta.join(' · ') })
          : el('span', { class: 'block truncate text-sm text-muted', text: `@${cardData.owner.username} · ${meta.join(' · ')}` }),
      ]),
      visibilityPill(cardData.visibility),
    ]);
  }

  async function showMine(listHost) {
    listHost.replaceChildren(loading({ label: t('saved.loadingLists') }));
    let lists;
    try {
      lists = await saved.fetchMyLists();
    } catch {
      listHost.replaceChildren(errorState({
        title: t('saved.errorTitle'),
        description: t('saved.errorBody'),
        onRetry: () => showMine(listHost),
      }));
      return;
    }
    if (!lists.length) {
      listHost.replaceChildren(
        emptyState({
          title: t('saved.emptyMineTitle'),
          description: t('saved.emptyMineBody'),
          action: button(t('saved.newList'), {
            variant: 'primary',
            onClick: () => openListForm({
              onSaved: (created) => {
                toast(t('saved.listCreated'));
                go({ list: created.id, view: 'mine' });
              },
            }),
          }),
        }),
      );
      return;
    }
    listHost.replaceChildren(
      el('div', { class: 'flex flex-col gap-2' },
        lists.map((list) => listRow(list, { owner: true, onClick: () => go({ list: list.id, view: 'mine' }) }))),
    );
  }

  async function showPublic(listHost) {
    listHost.replaceChildren(loading({ label: t('saved.loadingLists') }));
    let page;
    try {
      page = await saved.fetchPublicLists({ limit: PAGE_LIMIT });
    } catch {
      listHost.replaceChildren(errorState({
        title: t('saved.errorTitle'),
        description: t('saved.errorBody'),
        onRetry: () => showPublic(listHost),
      }));
      return;
    }
    const rows = el('div', { class: 'flex flex-col gap-2' },
      page.items.map((list) => listRow(list, { onClick: () => go({ list: list.id, view: 'public' }) })));
    const host_ = el('div', { class: 'flex flex-col gap-3' }, [rows]);

    async function loadMore() {
      try {
        const next = await saved.fetchPublicLists({ offset: page.nextOffset, limit: PAGE_LIMIT });
        page = next;
        for (const list of next.items) {
          rows.appendChild(listRow(list, { onClick: () => go({ list: list.id, view: 'public' }) }));
        }
        if (!next.hasMore) moreBtn.remove();
      } catch {
        toast(t('saved.errorBody'), { error: true });
      }
    }

    let moreBtn = null;
    if (page.hasMore) {
      moreBtn = button(t('saved.showMore'), {
        variant: 'secondary',
        attrs: { dataset: { savedShowMore: 'true' } },
        onClick: loadMore,
      });
      host_.appendChild(moreBtn);
    }
    listHost.replaceChildren(host_);
    if (!page.items.length) {
      listHost.replaceChildren(
        emptyState({
          title: t('saved.emptyPublicTitle'),
          description: t('saved.emptyPublicBody'),
        }),
      );
    }
  }

  // ---- list detail mode ----

  async function showList({ listId, itemId, key: listKey, view: fromView }) {
    host.replaceChildren(loading({ label: t('saved.loadingList') }));
    let detail;
    try {
      detail = await saved.fetchList(listId, { key: listKey });
    } catch (err) {
      const unseen = err && (err.status === 404 || err.status === 403);
      host.replaceChildren(
        errorState({
          title: unseen ? t('saved.notFoundTitle') : t('saved.errorTitle'),
          description: unseen ? t('saved.notFoundBody') : t('saved.errorBody'),
          onRetry: unseen ? null : () => showList({ listId, itemId, key: listKey, view: fromView }),
        }),
      );
      return;
    }
    const { list, items, suggestions, viewer } = detail;
    if (itemId) {
      const item = items.find((it) => String(it.id) === String(itemId));
      if (!item) {
        host.replaceChildren(
          errorState({ title: t('saved.notFoundTitle'), description: t('saved.itemNotFoundBody') }),
        );
        return;
      }
      const detailView = createItemDetailView({
        list,
        item,
        viewer,
        key: listKey,
        onBack: () => go({ list: listId, view: fromView, key: listKey }),
        onItemRemoved: () => go({ list: listId, view: fromView, key: listKey }),
      });
      host.replaceChildren(detailView.root);
      return;
    }
    renderListDetail({ list, items, suggestions, viewer, fromView, listKey });
  }

  function renderListDetail({ list, items, suggestions, viewer, fromView, listKey }) {
    const isOwner = Boolean(viewer.isOwner);
    const backBtn = el('button', {
      type: 'button',
      class:
        'self-start rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      dataset: { savedListBack: 'true' },
      onClick: () => go({ view: fromView }),
    }, [t('common.back')]);

    const header = el('div', { class: 'flex flex-col gap-1', dataset: { savedListDetail: 'true' } }, [
      el('div', { class: 'flex items-center gap-3' }, [
        emojiBadge(list.emoji, { class: 'h-14 w-14 text-3xl' }),
        el('div', { class: 'min-w-0 flex-1' }, [
          el('h2', { class: 'truncate text-lg font-semibold text-ink', text: list.name }),
          isOwner
            ? el('p', { class: 'text-sm text-muted', text: t('saved.yourList') })
            : el('p', { class: 'text-sm text-muted', text: `@${list.owner.username}` }),
        ]),
        visibilityPill(list.visibility),
      ]),
      el('p', { class: 'text-xs text-muted leading-relaxed', text: visibilityNote(list.visibility) }),
    ]);

    const ownerActions = isOwner
      ? el('div', { class: 'flex flex-wrap gap-2', dataset: { savedOwnerActions: 'true' } }, [
          button(t('common.edit'), {
            variant: 'secondary',
            attrs: { dataset: { savedEditList: 'true' } },
            onClick: () => openListForm({ list, onSaved: () => reloadList() }),
          }),
          confirmableButton(t('saved.delete'), t('saved.deleteListConfirm'), {
            variant: 'secondary',
            onConfirm: async () => {
              try {
                await saved.deleteList(list.id);
                toast(t('saved.listDeleted'));
                go({ view: fromView });
              } catch (err) {
                toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
              }
            },
          }),
        ])
      : null;

    // Share link: the owner of a Shared list gets the unguessable link.
    const shareRow = isOwner && list.visibility === 'link' && list.shareToken
      ? buildShareRow(list)
      : null;

    const primaryBtn = button(
      isOwner ? t('saved.addPlace') : t('saved.suggestPlace'),
      {
        variant: 'primary',
        attrs: { dataset: { savedAddPlace: 'true' } },
        onClick: () => {
          if (isOwner) {
            openPlaceSheet({
              mode: 'add',
              onConfirm: async (place) => {
                await saved.addPlace(list.id, saved.placeToSnapshot(place));
                toast(t('saved.itemAdded'));
                reloadList();
              },
            });
          } else {
            openPlaceSheet({
              mode: 'suggest',
              onConfirm: async (place, message) => {
                await saved.suggestPlace(list.id, saved.placeToSnapshot(place), message);
                toast(t('saved.suggestSent'));
              },
            });
          }
        },
      });

    const suggestionsSection = isOwner && suggestions.length
      ? buildSuggestions(suggestions)
      : null;

    const itemsSection = buildItems(items);

    host.replaceChildren(
      ...[backBtn, header, ownerActions, shareRow, primaryBtn, suggestionsSection, itemsSection]
        .filter(Boolean),
    );

    function reloadList() {
      showList({ listId, itemId: null, key: listKey, view: fromView });
    }

    function buildShareRow(listData) {
      const link = `${window.location.origin}${window.location.pathname}#/saved?list=${encodeURIComponent(listData.id)}&key=${encodeURIComponent(listData.shareToken)}`;
      const field = el('input', {
        type: 'text',
        readonly: true,
        value: link,
        class:
          'w-full min-w-0 rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-muted',
        'aria-label': t('saved.shareLink'),
        dataset: { savedShareLink: 'true' },
      });
      return card([
        el('p', { class: 'text-sm font-medium text-ink', text: t('saved.shareLink') }),
        el('p', { class: 'text-xs text-muted', text: t('saved.shareLinkHint') }),
        el('div', { class: 'mt-1 flex gap-2' }, [
          field,
          button(t('saved.copyLink'), {
            variant: 'secondary',
            attrs: { dataset: { savedCopyLink: 'true' } },
            onClick: async () => {
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(link);
                } else {
                  field.select();
                  document.execCommand('copy');
                }
                toast(t('saved.linkCopied'));
              } catch {
                field.select();
                toast(t('saved.linkCopyFailed'), { error: true });
              }
            },
          }),
        ]),
      ]);
    }

    function buildSuggestions(pending) {
      return el('section', { class: 'flex flex-col gap-2', dataset: { savedSuggestions: 'true' } }, [
        el('p', {
          class: 'text-xs font-medium uppercase tracking-wide text-muted',
          text: `${t('saved.suggestions')} (${pending.length})`,
        }),
        ...pending.map((suggestion) =>
          card([
            el('p', { class: 'text-sm font-semibold text-ink', text: suggestion.place.name }),
            el('p', {
              class: 'text-xs text-muted',
              text: t('saved.suggestedBy').replace('{name}', suggestion.from.username),
            }),
            suggestion.message
              ? el('p', { class: 'text-sm text-ink leading-relaxed', text: suggestion.message })
              : null,
            (suggestion.place.address || suggestion.place.kind)
              ? el('p', { class: 'text-xs text-muted', text: suggestion.place.address || suggestion.place.kind })
              : null,
            el('div', { class: 'flex gap-2 pt-1' }, [
              button(t('saved.accept'), {
                variant: 'primary',
                attrs: { dataset: { savedAcceptSuggestion: suggestion.id } },
                onClick: () => decide(suggestion, 'accept'),
              }),
              button(t('saved.reject'), {
                variant: 'secondary',
                attrs: { dataset: { savedRejectSuggestion: suggestion.id } },
                onClick: () => decide(suggestion, 'reject'),
              }),
            ]),
          ])),
      ]);

      async function decide(suggestion, decision) {
        try {
          await (decision === 'accept'
            ? saved.acceptSuggestion(suggestion.id)
            : saved.rejectSuggestion(suggestion.id));
          toast(decision === 'accept' ? t('saved.suggestionAccepted') : t('saved.suggestionRejected'));
          reloadList();
        } catch (err) {
          toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
        }
      }
    }

    function buildItems(listItems) {
      if (!listItems.length) {
        return el('section', { class: 'flex flex-col gap-2', dataset: { savedItems: 'true' } }, [
          emptyState({
            title: t('saved.listEmptyTitle'),
            description: isOwner
              ? t('saved.listEmptyBodyOwner')
              : t('saved.listEmptyBody'),
          }),
        ]);
      }
      return el('section', { class: 'flex flex-col gap-2', dataset: { savedItems: 'true' } }, [
        el('p', {
          class: 'text-xs font-medium uppercase tracking-wide text-muted',
          text: t('saved.placeCount').replace('{count}', String(listItems.length)),
        }),
        ...listItems.map((item) => {
          const meta = [];
          if (item.source === 'suggestion' && item.addedBy) {
            meta.push(t('saved.suggestedByShort').replace('{name}', item.addedBy.username));
          }
          if (item.commentCount > 0) {
            meta.push(t('saved.commentCount').replace('{count}', String(item.commentCount)));
          }
          if (item.note) meta.push(t('saved.hasNote'));
          return el('button', {
            type: 'button',
            class:
              'flex w-full items-start gap-3 rounded-card border border-line bg-surface p-4 text-left shadow-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            dataset: { savedItemRow: item.id },
            onClick: () => go({ list: listId, item: item.id, view: fromView, key: listKey }),
          }, [
            emojiBadge(list.emoji, { class: 'h-9 w-9 text-lg' }),
            el('span', { class: 'min-w-0 flex-1' }, [
              el('span', { class: 'block truncate text-sm font-semibold text-ink', text: item.place.name }),
              item.place.address
                ? el('span', { class: 'block truncate text-xs text-muted', text: item.place.address })
                : null,
              meta.length
                ? el('span', { class: 'block truncate text-xs text-muted', text: meta.join(' · ') })
                : null,
            ]),
          ]);
        }),
      ]);
    }
  }
}
