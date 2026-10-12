// Location Sharing (Phase 12F) — the Profile sub-screen at #/sharing.
//
// Two halves, one screen:
//
//   Sharing with others  your own active share (or the way to start one),
//                        its device status, its expiry, and the way to stop
//   Sharing with you     the shares you are a recipient of, with the honest
//                        age of every last fix
//
// Everything here is a thin binding over services/sharing.js and the seven
// real /api/sharing routes. The honest states are first-class: feature off,
// signed out, roster unavailable, permission lost, offline, stale, expired —
// each is named in words, never guessed away. The ?demo=1 state (staging
// only) renders fixed canned data and never touches the API.
'use strict';

import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { loading } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { errorState } from '../components/error-state.js';
import { present } from '../components/surface.js';
import {
  noticeCard,
  recipientPicker,
  durationPicker,
  shareRow,
  recipientRow,
  statusLine,
  expiryLine,
} from '../components/sharing/parts.js';
import { hasToken } from '../auth.js';
import { getState } from '../state.js';
import { t, getLocale } from '../i18n/index.js';
import { formatTime } from '../i18n/format.js';
import { getCurrentLocation } from '../services/location.js';
import * as router from '../router.js';
import {
  fetchSharingMembers,
  fetchMySession,
  fetchIncoming,
  startShare,
  stopShare,
  dismissIncoming,
  ensureSharingLoop,
  stopSharingLoop,
  consentToSession,
  consentedTo,
  deviceStatusText,
  SHARING_LOOP,
} from '../services/sharing.js';
import { SHARING_INTERVAL_MS, startErrorCopy } from '../services/sharing-core.js';

export async function render(ctx) {
  const host = el('div', { class: 'flex flex-col gap-4', dataset: { sharingHost: 'loading' } });
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold text-ink', text: t('sharing.title') }),
    el('p', {
      class: 'mt-1 text-sm text-muted leading-relaxed',
      text: t('sharing.intro'),
    }),
    host,
  );

  // Deep-link states, read from both the URL query and the hash query, like
  // the home screen reads ?map=.
  const params = readParams();
  const config = getState().config || {};
  const features = config.features || {};

  // The operator switch mirrored into /api/config: same honest state, no
  // gated call, and it is the truth in staging and production alike.
  if (params.get('sharing') === 'unavailable' || features.locationSharing === false) {
    host.dataset.sharingHost = 'unavailable';
    host.replaceChildren(
      noticeCard({
        title: t('sharing.unavailableTitle'),
        body: t('sharing.unavailableBody'),
        dataset: { sharingUnavailable: 'true' },
      }),
    );
    return;
  }

  // The canned demo needs no identity and makes no request, so it comes
  // before the signed-out check: a staging preview (and its checks) renders
  // it signed-out too.
  if (params.get('demo') === '1' && config.environment === 'staging') {
    renderDemo(host);
    return;
  }

  if (!hasToken()) {
    host.dataset.sharingHost = 'signed_out';
    host.replaceChildren(
      emptyState({
        title: t('sharing.signedOutTitle'),
        description: t('sharing.signedOutBody'),
      }),
    );
    return;
  }

  host.replaceChildren(loading({ label: t('sharing.loading') }));

  let mine = null;
  let incoming = null;
  let err = null;
  try {
    [mine, incoming] = await Promise.all([fetchMySession(), fetchIncoming()]);
  } catch (e) {
    err = e;
  }

  if (err) {
    host.dataset.sharingHost = 'error';
    host.replaceChildren(
      errorState({
        title: t('sharing.loadFailedTitle'),
        description: (err && err.message) || t('sharing.loadFailedBody'),
        onRetry: () => router.navigate('sharing'),
      }),
    );
    return;
  }

  host.dataset.sharingHost = 'ready';
  host.replaceChildren(
    renderOutgoing(mine && mine.session),
    renderIncoming(incoming && incoming.shares),
  );
  startIncomingPoll(host);
}

// ── Sharing with others ───────────────────────────────────────────────────

function renderOutgoing(session) {
  const card = el('div', {
    class: 'flex flex-col gap-3',
    dataset: { sharingOutgoing: 'true' },
  });
  const title = el('p', { class: 'text-base font-semibold text-ink', text: t('sharing.withOthers') });

  if (!session) {
    card.append(
      el('div', { class: 'rounded-card border border-line bg-surface p-4' }, [
        title,
        el('p', {
          class: 'mt-1 text-sm text-muted leading-relaxed',
          text: t('sharing.noneOutgoing'),
        }),
        el('div', { class: 'mt-3' }, [
          button(t('sharing.start'), {
            attrs: { dataset: { startSharing: 'true' } },
            onClick: () => openStartSheet(),
          }),
        ]),
      ]),
    );
    return card;
  }

  // An active share. If the person consented in this page load the loop is
  // already running (or starts now); otherwise updates are OFF and the
  // screen says so, with the resume action as the only way back on.
  const consented = consentedTo(session.id);
  const statusSlot = el('div', { class: 'flex flex-col gap-1', dataset: { sharingDeviceStatus: 'true' } });
  const recipientsList = el('ul', { class: 'divide-y divide-line' });

  const body = el('div', { class: 'rounded-card border border-line bg-surface p-4' }, [
    title,
    el('div', { class: 'mt-2 flex flex-col gap-2' }, [
      session && session.expiresAt
        ? el('p', {
            class: 'text-sm font-semibold text-ink',
            dataset: { sharingActiveUntil: 'true' },
            text: t('sharing.activeUntil', {
              ends: formatTime(new Date(session.expiresAt), { locale: getLocale() }),
            }),
          })
        : null,
      el('p', {
        class: 'text-xs text-muted',
        dataset: { sharingExpiry: 'true' },
        text: expiryLine(session, { t }) || '',
      }),
      statusSlot,
      recipientsList,
      el('p', {
        class: 'text-xs text-muted leading-relaxed',
        text: t('sharing.activeNote'),
      }),
    ]),
    el('div', { class: 'mt-3 flex flex-col gap-2' }, [
      consented
        ? null
        : el('div', { class: 'flex flex-col gap-2' }, [
            el('p', {
              class: 'text-sm font-semibold text-ink',
              dataset: { sharingResumePrompt: 'true' },
              text: t('sharing.resumeTitle'),
            }),
            button(t('sharing.resume'), {
              attrs: { dataset: { resumeSharing: 'true' } },
              onClick: () => resumeSharing(),
            }),
          ]),
      button(t('sharing.stop'), {
        variant: 'secondary',
        attrs: { dataset: { stopSharing: 'true' } },
        onClick: () => stopSharing(),
      }),
    ]),
  ]);

  const renderRecipients = () => {
    recipientsList.replaceChildren(
      ...(session.recipients || []).map((r) => recipientRow(r)),
    );
  };
  renderRecipients();

  const renderStatus = (snapshot) => {
    statusSlot.replaceChildren();
    const snapshotText = deviceStatusText(snapshot, { t });
    if (snapshot && snapshot.lastPostedAt) {
      statusSlot.append(
        el('p', {
          class: 'text-xs text-muted',
          dataset: { sharingLastPosted: 'true' },
          text: t('sharing.lastPosted', { age: postedAgo(snapshot.lastPostedAt) }),
        }),
      );
    }
    if (snapshotText) {
      statusSlot.append(
        statusLine(snapshotText, {
          tone:
            snapshot.state === SHARING_LOOP.ACTIVE
              ? 'on'
              : snapshot.state === SHARING_LOOP.ENDED
                ? 'off'
                : 'paused',
        }),
      );
    }
  };

  if (consented) {
    const loop = ensureSharingLoop(session, { onState: renderStatus });
    if (loop) loop.setOnState(renderStatus);
  }
  // Without consent the device status says plainly that updates are off.
  if (!consented) {
    renderStatus(null);
    statusSlot.append(
      el('p', {
        class: 'text-xs text-muted',
        dataset: { sharingPausedNoConsent: 'true' },
        text: t('sharing.pausedNoConsent'),
      }),
    );
  }

  card.append(body);
  return card;
}

// Resume: one explicit tap plus a fresh permission check. Only a real fix
// turns consent on — a denied check leaves updates off and says why.
async function resumeSharing() {
  let mine;
  try {
    mine = await fetchMySession();
  } catch {
    return;
  }
  const session = mine && mine.session;
  if (!session) return;
  try {
    await getCurrentLocation();
  } catch (err) {
    toast(
      err && err.message ? err.message : t('sharing.locationOffTitle'),
      { error: true },
    );
    return;
  }
  consentToSession(session.id);
  rerender();
}

async function stopSharing() {
  try {
    const mine = await fetchMySession();
    const session = mine && mine.session;
    if (!session) {
      stopSharingLoop();
      rerender();
      return;
    }
    await stopShare(session.id);
    stopSharingLoop();
    toast(t('sharing.stopped'));
    rerender();
  } catch (err) {
    toast(err && err.message ? err.message : t('sharing.stopFailed'), { error: true });
  }
}

// ── Sharing with you ──────────────────────────────────────────────────────

function renderIncoming(shares) {
  const rows = Array.isArray(shares) ? shares : [];
  const card = el('div', {
    class: 'flex flex-col gap-3',
    dataset: { sharingIncoming: 'true' },
  });
  card.append(el('p', { class: 'text-base font-semibold text-ink', text: t('sharing.withYou') }));

  if (rows.length === 0) {
    card.append(
      emptyState({
        title: t('sharing.emptyIncomingTitle'),
        description: t('sharing.emptyIncomingBody'),
      }),
    );
    return card;
  }

  card.append(
    el('ul', {
      class: 'divide-y divide-line rounded-card border border-line bg-surface',
      dataset: { sharingIncomingList: 'true' },
    }, rows.map((s) =>
      shareRow({
        share: s,
        onShow: () => showOnMap(s.id),
        onDismiss: () => dismissOne(s.id),
      }),
    )),
  );
  return card;
}

function showOnMap(id) {
  // The home screen owns the map; the id rides the hash query, exactly the
  // way the other deep links do. Setting the hash navigates (or re-renders
  // home when it is already showing that exact share).
  window.location.hash = '#/?share=' + encodeURIComponent(String(id));
}

async function dismissOne(id) {
  try {
    await dismissIncoming(id);
    toast(t('sharing.dismissed'));
    rerender();
  } catch (err) {
    toast(err && err.message ? err.message : t('sharing.dismissFailed'), { error: true });
  }
}

// The incoming list is server-computed ages on human-ish timescales; poll it
// at the same cadence as the update loop while the screen is on screen. The
// `isConnected` guard stops the chain the moment the screen is replaced.
function startIncomingPoll(host) {
  const step = () => {
    if (!host.isConnected) return;
    setTimeout(async () => {
      if (!host.isConnected) return;
      try {
        const incoming = await fetchIncoming();
        const list = host.querySelector('[data-sharing-incoming-list]');
        if (list && incoming && Array.isArray(incoming.shares)) {
          list.replaceChildren(
            ...incoming.shares.map((s) =>
              shareRow({
                share: s,
                onShow: () => showOnMap(s.id),
                onDismiss: () => dismissOne(s.id),
              }),
            ),
          );
        }
      } catch {
        /* a poll failure is silent; the next poll tries again */
      }
      step();
    }, SHARING_INTERVAL_MS);
  };
  step();
}

// ── The start sheet ───────────────────────────────────────────────────────

async function openStartSheet() {
  const body = el('div', { class: 'flex flex-col gap-3', dataset: { sharingStartSheet: 'true' } });
  const surface = present(body, {
    label: t('sharing.title'),
    onDismiss: () => {
      // Nothing to clean up: the sheet owns no timer and no loop. Closing it
      // is always safe.
    },
  });

  body.append(el('p', {
    class: 'text-sm text-muted',
    dataset: { sharingPeopleLoading: 'true' },
    text: t('sharing.peopleLoading'),
  }));

  let roster;
  try {
    roster = await fetchSharingMembers();
  } catch {
    roster = { available: false, members: [] };
  }

  if (!surface || !body.isConnected) return; // closed before the roster came back

  if (!roster.available || (roster.members || []).length === 0) {
    body.replaceChildren(
      noticeCard({
        title: t('sharing.rosterUnavailableTitle'),
        body: roster.available ? t('sharing.peopleEmpty') : t('sharing.rosterUnavailable'),
        dataset: { sharingRosterUnavailable: 'true' },
      }),
    );
    return;
  }

  // The picker never offers the signed-in person themselves.
  const me = getState().user || {};
  const people = (roster.members || []).filter((m) => String(m.id) !== String(me.id));

  let selected = []; // chosen roster members, in tap order
  let durationMinutes = 60;
  // Created ENABLED: button() only attaches the click listener when the
  // button is born enabled, so a disabled birth left this button permanently
  // deaf — the reported "nothing happens" bug. redraw() disables it before
  // the sheet is shown anyway, because nothing is selected yet.
  const confirmBtn = button(t('sharing.start'), {
    attrs: { dataset: { confirmStart: 'true' } },
    onClick: () => confirmStart(),
  });
  const errorSlot = el('div', { dataset: { sharingStartError: 'true' } });
  const consentSlot = el('div', { class: 'text-xs text-muted leading-relaxed', dataset: { sharingConsent: 'true' } });

  let busy = false; // from the first tap until the attempt resolves

  function setBusy(on) {
    busy = on;
    confirmBtn.disabled = on || selected.length === 0;
    confirmBtn.textContent = on ? t('sharing.starting') : t('sharing.start');
    if (on) confirmBtn.setAttribute('aria-busy', 'true');
    else confirmBtn.removeAttribute('aria-busy');
  }

  function redraw() {
    if (!busy) confirmBtn.disabled = selected.length === 0;
    const names = selected.map((m) => m.username);
    const endsAt = new Date(Date.now() + durationMinutes * 60_000);
    consentSlot.textContent =
      names.length === 0
        ? t('sharing.consentHint')
        : consentLine(names, endsAt);
  }

  function consentLine(names, endsAt) {
    return t('sharing.consent', {
      names: names.join(', '),
      ends: formatTime(endsAt, { locale: getLocale() }),
    });
  }

  const pickerSlot = el('div', { class: 'flex flex-col gap-3' });
  const renderPicker = () => {
    pickerSlot.replaceChildren(
      el('p', { class: 'text-sm font-semibold text-ink', text: t('sharing.peopleTitle') }),
      people.length === 0
        ? el('p', { class: 'text-sm text-muted', text: t('sharing.peopleEmpty') })
        : recipientPicker({
            members: people,
            selectedIds: selected.map((m) => m.id),
            onToggle: (m) => {
              const at = selected.findIndex((x) => String(x.id) === String(m.id));
              if (at >= 0) selected.splice(at, 1);
              else selected.push(m);
              renderPicker();
              redraw();
            },
          }),
      el('p', { class: 'text-sm font-semibold text-ink', text: t('sharing.durationTitle') }),
      durationPicker({
        selected: durationMinutes,
        onSelect: (minutes) => {
          durationMinutes = minutes;
          renderPicker();
          redraw();
        },
      }),
      consentSlot,
    );
  };
  renderPicker();
  redraw();

  // Start = one real fix, then the POST. A failed permission check means NO
  // session is created — the honest start, per the states table. Every
  // failure is named in the app's own words, on the card above the button;
  // the raw err.message (Directions copy, server English) never reaches the
  // screen. The busy flag makes a double tap a no-op and keeps redraw() from
  // re-enabling the button mid-flight.
  function showStartError(err) {
    const { titleKey, bodyKey } = startErrorCopy(err);
    errorSlot.replaceChildren(
      noticeCard({
        title: t(titleKey),
        body: t(bodyKey),
        dataset: { sharingStartBlocked: 'true' },
      }),
    );
    try {
      errorSlot.scrollIntoView({ block: 'nearest' });
    } catch {
      /* an old frame without scrollIntoView: the card is above the button anyway */
    }
  }

  async function confirmStart() {
    if (busy) return;
    setBusy(true);
    errorSlot.replaceChildren();
    try {
      await getCurrentLocation();
    } catch (err) {
      showStartError(err);
      // `reopening` means the shell is reloading this frame to apply the
      // fresh grant: leave the button resting, the reload is imminent.
      if (!(err && err.reason === 'reopening')) setBusy(false);
      return;
    }
    try {
      const out = await startShare(
        selected.map((m) => m.username),
        durationMinutes,
      );
      const session = out && out.session;
      if (session && session.id != null) consentToSession(session.id);
      surface.dismiss();
      rerender();
    } catch (err) {
      showStartError(err);
      setBusy(false);
    }
  }

  body.replaceChildren(pickerSlot, errorSlot, confirmBtn);
}

// ── Demo (staging only) ───────────────────────────────────────────────────

// Fixed, canned data: one fake active share and one fake incoming share. No
// request, no write, and the actions are inert — a preview of the layout,
// never a live share.
function renderDemo(host) {
  host.dataset.sharingHost = 'demo';
  const now = Date.now();
  const demoSession = {
    id: 'demo',
    createdAt: new Date(now - 18 * 60_000).toISOString(),
    expiresAt: new Date(now + 42 * 60_000).toISOString(),
    recipients: [
      { userId: '900001', username: 'Staging demo user' },
    ],
  };
  const demoShare = {
    id: 'demo',
    sharer: { username: 'Staging demo user' },
    fixAgeSeconds: 120,
  };

  host.replaceChildren(
    el('p', {
      class: 'rounded-card border border-dashed border-line p-3 text-xs text-muted',
      dataset: { sharingDemoBanner: 'true' },
      text: t('sharing.demoBanner'),
    }),
    renderOutgoingDemo(demoSession),
    renderIncomingDemo(demoShare),
  );
}

function renderOutgoingDemo(session) {
  const body = el('div', { class: 'rounded-card border border-line bg-surface p-4' }, [
    el('p', { class: 'text-base font-semibold text-ink', text: t('sharing.withOthers') }),
    el('div', { class: 'mt-2 flex flex-col gap-2' }, [
      el('p', {
        class: 'text-xs text-muted',
        text: t('sharing.expiresIn', { age: '42 ' + t('sharing.minShort') }),
      }),
      statusLine(t('sharing.postingOn'), { tone: 'on' }),
      el('ul', { class: 'divide-y divide-line' }, session.recipients.map((r) => recipientRow(r))),
      el('p', { class: 'text-xs text-muted leading-relaxed', text: t('sharing.activeNote') }),
    ]),
    el('div', { class: 'mt-3' }, [
      button(t('sharing.stop'), { variant: 'secondary', disabled: true }),
    ]),
  ]);
  return el('div', { class: 'flex flex-col gap-3', dataset: { sharingOutgoing: 'demo' } }, [body]);
}

function renderIncomingDemo(share) {
  const list = el('ul', {
    class: 'divide-y divide-line rounded-card border border-line bg-surface',
    dataset: { sharingIncomingList: 'demo' },
  }, [
    shareRow({ share, onShow: null, onDismiss: null }),
  ]);
  return el('div', { class: 'flex flex-col gap-3', dataset: { sharingIncoming: 'demo' } }, [
    el('p', { class: 'text-base font-semibold text-ink', text: t('sharing.withYou') }),
    list,
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function postedAgo(postedAt) {
  const seconds = Math.max(0, (Date.now() - postedAt) / 1000);
  if (seconds < 60) return '1 ' + t('sharing.minShort');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' ' + t('sharing.minShort');
  const hours = Math.round(minutes / 60);
  return hours + ' ' + t('sharing.hourShort');
}

// Read the URL query AND the query after the hash, merged (hash wins) — the
// same both-places read every other deep link uses, so `?token=` in the
// search never hides a hash parameter.
function readParams() {
  const merged = new URLSearchParams();
  try {
    for (const [k, v] of new URLSearchParams(window.location.search)) merged.set(k, v);
  } catch {
    /* no URL */
  }
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const q = hash.indexOf('?');
    if (q >= 0) {
      for (const [k, v] of new URLSearchParams(hash.slice(q + 1))) merged.set(k, v);
    }
  } catch {
    /* no hash */
  }
  return merged;
}

// The same toast the home screen uses: the native kit's when it is there,
// a console note when it is not.
function toast(message, { error = false } = {}) {
  const kit = window.unNative;
  if (kit && typeof kit.toast === 'function') {
    try {
      kit.toast(message, error ? { error: true } : {});
      return;
    } catch {
      /* fall through to a console note */
    }
  }
  console.info('[sharing] ' + message);
}

function rerender() {
  router.navigate('sharing');
}
