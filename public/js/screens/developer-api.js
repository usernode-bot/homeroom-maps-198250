// Developer API — the Phase 12K screen. One job: let a signed-in person
// create, list and revoke their own API keys for the read-only /api/v1
// surface, and show honestly what that surface serves today.
//
// The full plaintext key exists exactly once, in the create response (the
// server stores only a hash), so the create flow shows it in a dialog with a
// Copy action and says plainly that it is not shown again. Every state is
// real: the list is the server's list, an error is the shared error state
// with Try again, and an empty list says so instead of pretending.
import { el } from '../components/dom.js';
import { card } from '../components/card.js';
import { button } from '../components/button.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { loading } from '../components/loading.js';
import { present } from '../components/surface.js';
import { promptText, confirmAction } from '../components/saved/dialogs.js';
import { hasToken } from '../auth.js';
import { fetchConfig } from '../api.js';
import { fetchDeveloperApi, createApiKey, revokeApiKey } from '../services/developer-api.js';
import { t } from '../i18n/index.js';

function toast(message, { error = false } = {}) {
  const kit = window.unNative;
  if (kit && typeof kit.toast === 'function') {
    kit.toast(message, error ? { priority: true } : {});
  }
}

export async function render(ctx) {
  const host = el('div', { class: 'flex flex-col gap-3', dataset: { developerApiHost: 'true' } });
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('developerApi.title') }),
    el('p', { class: 'text-sm text-muted leading-relaxed', text: t('developerApi.intro') }),
    host,
  );

  if (!hasToken()) {
    // Guests can still read what the API offers below; only the key list is
    // theirs to manage.
    host.append(
      emptyState({
        title: t('developerApi.signInTitle'),
        description: t('developerApi.signInBody'),
      }),
    );
  } else {
    await renderKeys(host);
  }
  // The two read-only cards below are useful even when the key list failed,
  // and the config read is independent of the key list.
  host.append(await offersCard());
  host.append(quickStartCard());
}

// ---- the key list ---------------------------------------------------------

async function renderKeys(host) {
  const keysHost = el('div', { class: 'flex flex-col gap-3' }, [loading()]);
  host.replaceChildren(keysHost);
  let data;
  try {
    data = await fetchDeveloperApi();
  } catch {
    keysHost.replaceChildren(
      errorState({
        title: t('developerApi.loadError'),
        description: t('developerApi.loadErrorBody'),
        onRetry: () => renderKeys(host),
      }),
    );
    return;
  }
  keysHost.replaceChildren(keysCard(host, data));
}

function keysCard(host, data) {
  // Revoked keys stay in the server's list for the audit trail; the screen
  // shows the active ones only, which is also what the per-user cap counts.
  const keys = (Array.isArray(data && data.keys) ? data.keys : []).filter((k) => !k.revokedAt);
  const service = data && data.service ? data.service : {};
  const rows = keys.map((record) => keyRow(host, record));
  return card(
    [
      el('p', { class: 'text-base font-semibold text-ink', text: t('developerApi.keysTitle') }),
      el('p', {
        class: 'mt-1 text-sm text-muted leading-relaxed',
        text: t('developerApi.keysIntro', { perMinute: service.rateLimitPerMinute, cost: service.directionsCost }),
      }),
      keys.length
        ? el('ul', { class: 'mt-3 flex flex-col gap-2', dataset: { apiKeyList: 'true' } }, rows)
        : emptyState({
            title: t('developerApi.emptyTitle'),
            description: t('developerApi.emptyBody'),
          }),
      el('div', { class: 'mt-3' }, [
        button(t('developerApi.create'), {
          variant: 'primary',
          attrs: { dataset: { createApiKey: 'true' } },
          onClick: () => createFlow(host),
        }),
      ]),
    ],
  );
}

function keyRow(host, record) {
  const created = record.createdAt ? new Date(record.createdAt) : null;
  const createdText = created && !Number.isNaN(created.getTime())
    ? created.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  return el('li', { class: 'flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2' }, [
    el('div', { class: 'min-w-0' }, [
      el('p', { class: 'truncate text-sm font-medium text-ink', text: record.name }),
      el('p', { class: 'mt-0.5 truncate text-xs text-muted', text: `${record.keyPrefix} · ${createdText}` }),
    ]),
    button(t('developerApi.revoke'), {
      variant: 'secondary',
      attrs: { dataset: { revokeApiKey: record.id } },
      onClick: () => revokeFlow(host, record),
    }),
  ]);
}

// ---- create and revoke ------------------------------------------------------

async function createFlow(host) {
  let data;
  try {
    data = await fetchDeveloperApi();
  } catch {
    toast(t('developerApi.loadError'), { error: true });
    return;
  }
  const cap = data && data.service ? data.service.maxKeysPerUser : null;
  const active = (Array.isArray(data && data.keys) ? data.keys : []).filter((k) => !k.revokedAt).length;
  if (cap && active >= cap) {
    toast(t('developerApi.limitReached', { max: cap }), { error: true });
    return;
  }
  const name = await promptText({
    title: t('developerApi.createTitle'),
    label: t('developerApi.nameLabel'),
    placeholder: t('developerApi.namePlaceholder'),
    confirmLabel: t('developerApi.create'),
  });
  if (!name) return;
  try {
    const created = await createApiKey(name);
    await showKeyOnce(created.key);
    await renderKeys(host);
  } catch (err) {
    toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
  }
}

async function revokeFlow(host, record) {
  const confirmed = await confirmAction({
    title: t('developerApi.revokeTitle'),
    message: t('developerApi.revokeConfirm', { name: record.name }),
    confirmLabel: t('developerApi.revoke'),
  });
  if (!confirmed) return;
  try {
    await revokeApiKey(record.id);
    toast(t('developerApi.revoked'));
    await renderKeys(host);
  } catch (err) {
    toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
  }
}

// The key is shown exactly once, in a dialog with a Copy action. The
// server stores only a hash, so once this dialog closes the value is gone.
function showKeyOnce(key) {
  const copyButton = button(t('developerApi.copy'), {
    variant: 'primary',
    attrs: { dataset: { copyApiKey: 'true' } },
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(key);
        copyButton.textContent = t('developerApi.copied');
        toast(t('developerApi.copied'));
      } catch {
        toast(t('developerApi.copyFailed'), { error: true });
      }
    },
  });
  const dialog = el('div', { class: 'flex flex-col gap-3' }, [
    el('p', { class: 'text-base font-semibold text-ink', text: t('developerApi.keyShownOnceTitle') }),
    el('p', { class: 'text-sm text-muted leading-relaxed', text: t('developerApi.keyShownOnceBody') }),
    el('code', {
      class: 'block max-w-full overflow-x-auto rounded-lg bg-surface px-3 py-2 text-xs text-ink break-all',
      text: key,
    }),
    copyButton,
    el('div', { class: 'mt-1' }, [
      button(t('developerApi.done'), {
        variant: 'secondary',
        onClick: () => handle.dismiss(),
      }),
    ]),
  ]);
  const handle = present(dialog, {
    label: t('developerApi.createTitle'),
    onDismiss: () => {},
  });
  return Promise.resolve();
}

// ---- the two read-only cards -------------------------------------------------

async function offersCard() {
  let config = null;
  try {
    config = await fetchConfig();
  } catch {
    config = null; // the card still renders, from the honest default labels
  }
  // Provider facts come from the same source /api/config serves. Only what
  // is actually configured goes under "Available today"; the rest stays in
  // "Not available yet" so the card can never advertise something a key
  // would get a 501 for.
  const searchProvider = Boolean(config && config.searchProvider);
  const routingConfigured = Boolean(config && config.routing && config.routing.configured);
  const placeProvider = (config && config.placeProvider) || null;
  return card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('developerApi.offersTitle') }),
    el('p', { class: 'mt-2 text-sm font-medium text-ink', text: t('developerApi.availableTitle') }),
    el('ul', { class: 'mt-1 flex flex-col gap-1 text-sm text-muted leading-relaxed' }, [
      searchProvider ? el('li', { text: t('developerApi.offerSearch') }) : null,
      routingConfigured ? el('li', { text: t('developerApi.offerDirections') }) : null,
      el('li', { text: t('developerApi.offerCommunity') }),
      placeProvider ? el('li', { text: t('developerApi.offerPlaces') }) : null,
    ]),
    el('p', { class: 'mt-3 text-sm font-medium text-ink', text: t('developerApi.notAvailableTitle') }),
    el('ul', { class: 'mt-1 flex flex-col gap-1 text-sm text-muted leading-relaxed' }, [
      searchProvider ? null : el('li', { text: t('developerApi.notOfferSearch') }),
      routingConfigured ? null : el('li', { text: t('developerApi.notOfferDirections') }),
      placeProvider ? null : el('li', { text: t('developerApi.notOfferPlaces') }),
      el('li', { text: t('developerApi.notOfferPrivate') }),
      el('li', { text: t('developerApi.notOfferWrites') }),
    ]),
  ]);
}

function quickStartCard() {
  const example = `curl "${window.location.origin}/api/v1/search?q=coffee" \\\n  -H "Authorization: Bearer hm_live_..."`;
  return card([
    el('p', { class: 'text-base font-semibold text-ink', text: t('developerApi.quickStartTitle') }),
    el('p', { class: 'mt-1 text-sm text-muted leading-relaxed', text: t('developerApi.quickStartBody') }),
    el('code', {
      class: 'mt-2 block max-w-full overflow-x-auto rounded-lg bg-surface px-3 py-2 text-xs text-ink whitespace-pre',
      text: example,
    }),
    el('p', { class: 'mt-2 text-sm text-muted leading-relaxed', text: t('developerApi.attribution') }),
  ]);
}
