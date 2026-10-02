// Assistant session core — the pure, import-free state machine behind the
// assistant sheet. Like search-session.js it imports nothing and takes the
// one side-effectful call (sending a turn) as an injected function, so
// node:test can drive every state (unavailable, loading, ready, error,
// confirmation) without a DOM and without any network or model call.
//
// What this module is responsible for:
//   - the transcript, held in memory only for the life of the sheet (never
//     persisted anywhere),
//   - turning a server error into an honest, typed state (unavailable,
//     grant needed, cap reached, budget reached, busy, provider error),
//   - the confirmation flow: an action proposal is never executed here. The
//     core only decides WHERE a confirmed action navigates; the actual write
//     is issued by the screen through the existing domain service.
//
// It deliberately knows nothing about fetch, localStorage or the DOM.
'use strict';

export const ASSISTANT_STATES = ['idle', 'loading', 'ready', 'unavailable', 'error'];

// Error code -> what the person should do. `retry` decides whether a Try
// again button makes sense; a cap or budget resets at midnight UTC, so it
// does not (and a grant prompt is offered by the screen instead).
export const ERROR_ACTIONS = {
  not_configured: { key: 'assistant.unavailableBody', retry: false },
  ai_unavailable: { key: 'assistant.unavailableBody', retry: false },
  grant_required: { key: 'assistant.grantBody', retry: true, grant: true },
  app_cap_exceeded: { key: 'assistant.capBody', retry: false },
  budget_exceeded: { key: 'assistant.budgetBody', retry: false },
  rate_limited: { key: 'assistant.busyBody', retry: true },
  provider_error: { key: 'assistant.errorBody', retry: true },
  network_error: { key: 'assistant.networkBody', retry: true },
  invalid_request: { key: 'assistant.errorBody', retry: true },
};

export function initialState() {
  return {
    status: 'idle',
    open: false,
    messages: [], // { role: 'user' | 'assistant', text }
    actions: [], // { tool, summary, args }
    error: null, // { code, message, retry, grant }
    usage: null, // { spentCents, capCents }
    confirming: false,
    notice: null, // a local, non-persistent line (for example a demo refusal)
  };
}

// A bounded, human-readable usage line ("Used $0.03 of $1.00 today"), or null
// when the meter is not available. Cents may be fractional.
export function usageLabel(usage, copy) {
  if (!usage) return null;
  const spent = Number(usage.spentCents);
  const cap = Number(usage.capCents);
  if (!Number.isFinite(spent) || !Number.isFinite(cap) || cap <= 0) return null;
  return copy('assistant.usage', {
    spent: (spent / 100).toFixed(2),
    cap: (cap / 100).toFixed(2),
  });
}

// A server/ApiError -> the typed error state the sheet renders.
export function errorStateFor(err) {
  const code = (err && err.code) || 'provider_error';
  const spec = ERROR_ACTIONS[code] || ERROR_ACTIONS.provider_error;
  return {
    code,
    message: (err && err.message) || null,
    retry: Boolean(spec.retry),
    grant: Boolean(spec.grant),
    copyKey: spec.key,
  };
}

// Turn an action proposal into a client navigation, if it is one of the two
// read-only views. Write actions (save place, add trip item) return null:
// their effect is the domain call the screen makes after confirmation.
export function actionNavigation(action) {
  if (!action || typeof action !== 'object') return null;
  const args = action.args || {};
  if (action.tool === 'show_route') {
    return { kind: 'route', destination: args.destination || null, origin: args.origin || null, mode: args.mode || null };
  }
  if (action.tool === 'open_community') {
    return { kind: 'community', tab: args.tab || 'proposals', view: args.view || null };
  }
  return null;
}

export function createAssistantSession({ sendTurn, copy, onNavigate, confirm } = {}) {
  if (typeof sendTurn !== 'function') throw new Error('createAssistantSession needs sendTurn');
  const t = copy || ((key) => key);
  let state = initialState();
  let onChange = null;
  // Guards against a stale response landing after a newer turn.
  let token = 0;

  function set(patch) {
    state = { ...state, ...patch };
    if (onChange) onChange(state);
  }

  function open() {
    set({ open: true });
  }
  function close() {
    set({ open: false });
  }
  function subscribe(fn) {
    onChange = fn;
    return () => {
      if (onChange === fn) onChange = null;
    };
  }

  // Push a user turn and ask the server. The transcript sent is the real
  // in-memory one; nothing is persisted.
  async function send(text) {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean || state.status === 'loading') return;
    const messages = state.messages.concat({ role: 'user', text: clean });
    const mine = ++token;
    set({ status: 'loading', messages, error: null, notice: null });
    try {
      const answer = await sendTurn({ messages });
      if (mine !== token) return;
      set({
        status: 'ready',
        messages: messages.concat({ role: 'assistant', text: (answer && answer.reply) || t('assistant.noReply') }),
        actions: Array.isArray(answer && answer.actions) ? answer.actions : [],
        usage: (answer && answer.usage) || state.usage,
        error: null,
      });
    } catch (err) {
      if (mine !== token) return;
      const es = errorStateFor(err);
      if (es.code === 'not_configured' || es.code === 'ai_unavailable') {
        set({ status: 'unavailable', error: es });
        return;
      }
      set({ status: 'error', error: es });
    }
  }

  // Mark the surface unavailable without any request (either proxy value
  // missing, detected via /api/assistant/status). Never errors.
  function markUnavailable(detail = null) {
    set({ status: 'unavailable', error: errorStateFor({ code: 'not_configured', message: detail }) });
  }

  // Deliver a canned, local turn with NO network call: used only by the
  // staging `?demo=1` UI mock. It appends a fixed user line, a fixed reply and
  // fixed action proposals to the in-memory transcript; nothing is sent, and
  // the confirm handler for a demo action is inert (see the component).
  function deliver({ userText, reply, actions = [] } = {}) {
    const messages = state.messages.concat(
      userText ? [{ role: 'user', text: userText }] : [],
      reply ? [{ role: 'assistant', text: reply }] : [],
    );
    set({ status: 'ready', messages, actions, error: null });
  }

  // The person tapped Try again: re-send the last user turn.
  function retry() {
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return Promise.resolve();
    // Drop the failed assistant turn if one was appended, then resend.
    const trimmed = state.messages[state.messages.length - 1];
    if (trimmed && trimmed.role === 'assistant') state.messages = state.messages.slice(0, -1);
    return send(lastUser.text);
  }

  // Confirm one proposed action. This is the ONLY path that leads to a write.
  // `confirm` is the injected effect: the screen passes a function that calls
  // the existing domain service (save place / add trip item) and reports back.
  // A read-only view action navigates instead. Nothing writes in the core.
  async function confirmAction(action) {
    if (!action || state.confirming) return;
    const nav = actionNavigation(action);
    if (nav && onNavigate) {
      onNavigate(nav);
      set({ actions: state.actions.filter((a) => a !== action), notice: null });
      return;
    }
    if (typeof confirm !== 'function') return;
    set({ confirming: true, notice: null });
    try {
      const result = await confirm(action);
      set({
        confirming: false,
        actions: state.actions.filter((a) => a !== action),
        notice: (result && result.notice) || t('assistant.doneNote'),
      });
    } catch (err) {
      set({
        confirming: false,
        notice: (err && err.message) || t('assistant.actionFailed'),
      });
    }
  }

  function dismissAction(action) {
    set({ actions: state.actions.filter((a) => a !== action), notice: null });
  }

  return {
    getState: () => state,
    subscribe,
    open,
    close,
    send,
    retry,
    deliver,
    markUnavailable,
    confirmAction,
    dismissAction,
  };
}
