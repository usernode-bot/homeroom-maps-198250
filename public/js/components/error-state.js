// Error state — says what went wrong and offers one way forward. Used by the
// global error boundary and by any screen whose fetch fails, so a failure
// never shows a blank page or a raw stack.
import { el } from './dom.js';
import { button } from './button.js';

export function errorState({ title = 'Something went wrong', description, onRetry } = {}) {
  return el(
    'div',
    {
      class: 'flex flex-col items-center gap-3 py-10 text-center',
      role: 'alert',
      dataset: { error: 'true' },
    },
    [
      el('p', { class: 'text-base font-semibold text-ink', text: title }),
      description
        ? el('p', { class: 'max-w-sm text-sm text-muted leading-relaxed', text: description })
        : null,
      onRetry ? button('Try again', { variant: 'secondary', onClick: onRetry }) : null,
    ],
  );
}
