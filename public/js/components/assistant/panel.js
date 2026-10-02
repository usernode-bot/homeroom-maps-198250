// Assistant panel — the "Ask about the map" sheet content.
//
// It is a pure projection of the assistant session (services/assistant-core.js):
// the session owns the transcript, the state and the confirmation decision;
// this component only draws them with the app's existing components. It never
// talks to the network except through the session, and it never issues a
// write: a confirmed write action is handed to the injected `confirmWrite`,
// which calls the EXISTING domain service.
//
// Nothing here renders model output as HTML: replies are text nodes.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { t } from '../../i18n/index.js';
import { usageLabel } from '../../services/assistant-core.js';

// A localized, human-readable summary of one proposed action. Built from the
// validated args only; the server's English `summary` is a fallback.
export function actionSummaryText(action) {
  const args = (action && action.args) || {};
  if (action.tool === 'save_place') {
    return t('assistant.action.save', {
      name: (args.place && args.place.name) || '',
      list: args.listRef || t('assistant.listFavorites'),
    });
  }
  if (action.tool === 'add_trip_item') {
    return t('assistant.action.addTrip', { name: (args.place && args.place.name) || '' });
  }
  if (action.tool === 'show_route') {
    return t('assistant.action.route', {
      name: (args.destination && args.destination.name) || t('assistant.destinationFallback'),
    });
  }
  if (action.tool === 'open_community') {
    return t('assistant.action.openCommunity', {
      tab: t(args.tab === 'reports' ? 'assistant.tab.reports' : 'assistant.tab.proposals'),
    });
  }
  return (action && action.summary) || '';
}


// Ask the platform shell for AI consent (bridge API) and retry once granted.
// Standalone (no shell) the call rejects; treat that as "still unavailable".
async function requestGrant(session) {
  const bridge = window.usernode;
  if (!bridge || typeof bridge.requestLlmAccess !== 'function') return;
  try {
    const answer = await bridge.requestLlmAccess();
    if (answer && answer.granted) session.retry();
  } catch {
    /* no shell or declined: the error state stays */
  }
}

const BUBBLE_BASE = 'max-w-[85%] rounded-card px-3 py-2 text-sm leading-relaxed';

export function createAssistantPanel({ session, onClose, onNavigate, confirmWrite, demo = false, submitLabel } = {}) {
  const root = el('div', { class: 'flex flex-col gap-3', dataset: { assistant: 'true' } });

  const title = el('p', { class: 'text-base font-semibold text-ink', text: t('assistant.title') });
  const meter = el('p', { class: 'text-xs text-muted', dataset: { assistantUsage: 'true' } });
  const closeBtn = el(
    'button',
    {
      type: 'button',
      class:
        'un-touch-target rounded-full p-1.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-label': t('assistant.close'),
      onClick: () => onClose && onClose(),
    },
    [icon('close', { class: 'h-5 w-5' })],
  );
  const header = el('div', { class: 'flex items-start justify-between gap-2' }, [
    el('div', { class: 'flex flex-col' }, [title, meter]),
    closeBtn,
  ]);

  const transcript = el('div', { class: 'flex flex-col gap-2', dataset: { assistantTranscript: 'true' } });
  const actionsHost = el('div', { class: 'flex flex-col gap-2', dataset: { assistantActions: 'true' } });
  const notice = el('p', {
    class: 'text-sm text-muted',
    dataset: { assistantNotice: 'true' },
    'aria-live': 'polite',
  });
  notice.hidden = true;

  const input = el('input', {
    type: 'text',
    class:
      'w-full rounded-pill border border-line bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60',
    placeholder: t('assistant.placeholder'),
    'aria-label': t('assistant.placeholder'),
    maxlength: '1000',
    dataset: { assistantInput: 'true' },
  });
  const sendBtn = button(submitLabel || t('assistant.send'), {
    attrs: { dataset: { assistantSend: 'true' }, 'aria-label': t('assistant.send') },
  });
  const composer = el('form', { class: 'flex items-center gap-2', dataset: { assistantComposer: 'true' } }, [input, sendBtn]);

  function submit() {
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    session.send(value);
  }
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  // A demo transcript is a fixed canned state: typing would go nowhere, so the
  // composer is inert in the demo and the copy explains why.
  if (demo) {
    input.disabled = true;
    sendBtn.disabled = true;
    input.placeholder = t('assistant.demoComposer');
  }

  function messageBubble(m) {
    const mine = m.role === 'user';
    return el('p', {
      class: `${BUBBLE_BASE} ${mine ? 'self-end bg-brand text-brand-contrast' : 'self-start bg-surface-raised text-ink'}`,
      text: m.text,
      dataset: { assistantMessage: m.role },
    });
  }

  function actionCard(action) {
    const card = el('div', {
      class: 'flex flex-col gap-2 rounded-card border border-line bg-surface p-3',
      dataset: { assistantAction: action.tool },
    });
    card.append(
      el('p', { class: 'text-sm font-medium text-ink', text: actionSummaryText(action) }),
      el('div', { class: 'flex justify-end gap-2' }, [
        button(t('assistant.notNow'), {
          variant: 'secondary',
          attrs: { dataset: { assistantDismiss: 'true' } },
          onClick: () => session.dismissAction(action),
        }),
        button(t('assistant.confirm'), {
          attrs: {
            dataset: { assistantConfirm: 'true' },
            // In the demo the confirm control is inert: it announces the local
            // no-op and reaches no endpoint.
            disabled: demo,
          },
          onClick: () => {
            if (demo) return;
            // The session decides: a read-only view action navigates through
            // the injected onNavigate; a write action runs the injected
            // confirmWrite, which calls the existing domain service.
            session.confirmAction(action);
          },
        }),
      ]),
    );
    return card;
  }

  function render() {
    const state = session.getState();
    const label = usageLabel(state.usage, t);
    meter.textContent = label || '';
    meter.hidden = !label;

    transcript.replaceChildren(...state.messages.map(messageBubble));
    actionsHost.replaceChildren(...state.actions.map(actionCard));

    if (state.status === 'loading') {
      transcript.append(el('div', { class: 'self-start', dataset: { assistantLoading: 'true' } }, [spinner()]));
    }

    // The honest unavailable state: no request was made, no error thrown.
    if (state.status === 'unavailable') {
      transcript.append(
        el('div', { class: 'rounded-card border border-dashed border-line p-3 text-sm text-muted', dataset: { assistantUnavailable: 'true' } }, [
          el('p', { class: 'font-medium text-ink', text: t('assistant.unavailableTitle') }),
          el('p', { text: t('assistant.unavailableBody') }),
        ]),
      );
    }

    if (state.error && state.status === 'error') {
      const box = el('div', { class: 'rounded-card border border-line p-3 text-sm', dataset: { assistantError: state.error.code } }, [
        el('p', { class: 'text-ink', text: t(state.error.copyKey) }),
      ]);
      if (state.error.grant) {
        // grant_required: ask the platform shell for consent, then retry once.
        box.append(
          el('div', { class: 'mt-2 flex justify-end' }, [
            button(t('assistant.grantAction'), {
              variant: 'secondary',
              attrs: { dataset: { assistantGrant: 'true' } },
              onClick: () => requestGrant(session),
            }),
          ]),
        );
      } else if (state.error.retry) {
        box.append(
          el('div', { class: 'mt-2 flex justify-end' }, [
            button(t('common.tryAgain'), {
              variant: 'secondary',
              attrs: { dataset: { assistantRetry: 'true' } },
              onClick: () => session.retry(),
            }),
          ]),
        );
      }
      transcript.append(box);
    }

    if (state.notice) {
      notice.textContent = state.notice;
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }

    const inert = demo || state.status === 'loading' || state.status === 'unavailable';
    input.disabled = inert;
    sendBtn.disabled = inert;
  }

  root.append(header, transcript, actionsHost, notice, composer);
  session.subscribe(render);
  render();
  return { root, render, focus: () => setTimeout(() => input.focus(), 0) };
}
