// Placeholder panel — the single, reusable "coming soon" surface. Every
// not-yet-built area of the app renders through this, so placeholders read as
// deliberate and consistent rather than as broken features. `controls` are
// disabled prototype controls (for example the Home map overlay); nothing
// here performs a real action.
import { el } from './dom.js';
import { button } from './button.js';
import { t } from '../i18n/index.js';

export function placeholderPanel({ title, description, controls = [], badge = t('common.comingSoon') } = {}) {
  return el(
    'div',
    {
      class: 'rounded-card border border-dashed border-line bg-surface/60 p-5 flex flex-col gap-3',
      dataset: { placeholder: 'true' },
    },
    [
      el('div', { class: 'flex items-center justify-between gap-3' }, [
        el('p', { class: 'text-base font-semibold text-ink', text: title }),
        badge
          ? el('span', {
              class:
                'shrink-0 rounded-pill bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent',
              text: badge,
            })
          : null,
      ]),
      description
        ? el('p', { class: 'text-sm text-muted leading-relaxed', text: description })
        : null,
      controls.length
        ? el(
            'div',
            { class: 'flex flex-wrap gap-2 pt-1' },
            controls.map((label) =>
              button(label, {
                variant: 'secondary',
                disabled: true,
                attrs: { title: t('common.comingSoon') },
              }),
            ),
          )
        : null,
    ],
  );
}
