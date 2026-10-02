// The two small dialogs Phase 7 needs: ask for a name, and confirm a delete.
//
// Both use the native kit's own surfaces when it is loaded (its alert dialog
// on touch, and the presented sheet/modal fallback from components/surface.js
// otherwise), so the app never grows a second dialog system.
import { el } from '../dom.js';
import { button } from '../button.js';
import { present } from '../surface.js';
import { t } from '../../i18n/index.js';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

// Ask for one line of text. Resolves the trimmed value, or null when the
// person dismissed it. `value` prefills it (rename).
export function promptText({ title, label, value = '', placeholder = '', confirmLabel }) {
  const kit = window.unNative;
  if (kit && typeof kit.alert === 'function') {
    try {
      return kit.alert({
        title,
        field: { placeholder: placeholder || label || '', value },
        buttons: [
          { label: kitCancelLabel(), style: 'cancel' },
          { label: confirmLabel, style: 'default' },
        ],
      }).then((answer) => {
        const text = answer && typeof answer.value === 'string' ? answer.value.trim() : '';
        return answer && answer.button && answer.button.style === 'default' && text ? text : null;
      });
    } catch {
      /* fall through to the presented form */
    }
  }
  return presentedForm({ title, label, value, placeholder, confirmLabel });
}

function presentedForm({ title, label, value, placeholder, confirmLabel }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const input = el('input', { type: 'text', class: INPUT, value, placeholder, maxlength: '60' });
    const form = el('form', { class: 'flex flex-col gap-3' }, [
      el('p', { class: 'text-base font-semibold text-ink', text: title }),
      el('label', { class: 'flex flex-col gap-1.5 text-sm text-muted' }, [
        label,
        input,
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        button(kitCancelLabel(), {
          variant: 'secondary',
          onClick: () => {
            surface.dismiss();
          },
        }),
        button(confirmLabel, {
          attrs: { type: 'submit' },
        }),
      ]),
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (text) {
        finish(text);
        surface.dismiss();
      }
    });
    const surface = present(form, {
      label: title,
      onDismiss: () => finish(null),
    });
    setTimeout(() => input.focus(), 0);
  });
}

// Confirm a destructive action. Resolves true only on an explicit confirm.
export function confirmAction({ title, message, confirmLabel }) {
  const kit = window.unNative;
  if (kit && typeof kit.alert === 'function') {
    try {
      return kit.alert({
        title,
        message,
        buttons: [
          { label: kitCancelLabel(), style: 'cancel' },
          { label: confirmLabel, style: 'destructive' },
        ],
      }).then((answer) => Boolean(answer && answer.button && answer.button.style === 'destructive'));
    } catch {
      /* fall through to the presented confirm */
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const panel = el('div', { class: 'flex flex-col gap-3' }, [
      el('p', { class: 'text-base font-semibold text-ink', text: title }),
      message ? el('p', { class: 'text-sm text-muted leading-relaxed', text: message }) : null,
      el('div', { class: 'flex justify-end gap-2' }, [
        button(kitCancelLabel(), {
          variant: 'secondary',
          onClick: () => {
            surface.dismiss();
          },
        }),
        button(confirmLabel, {
          variant: 'secondary',
          class: 'text-danger',
          onClick: () => {
            finish(true);
            surface.dismiss();
          },
        }),
      ]),
    ]);
    const surface = present(panel, { label: title, onDismiss: () => finish(false) });
  });
}

// The cancel label. The native kit's own dialogs have their own wording; this
// is only used by the presented fallback, and goes through the app's i18n like
// every other string.
function kitCancelLabel() {
  return t('common.cancel');
}
