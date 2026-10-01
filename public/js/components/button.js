// Button. Variants are whole literal class strings (Tailwind's extractor is a
// regex over source text, so a class assembled at runtime would be invisible):
// `primary` is the one filled action, `secondary` a quiet bordered action, and
// `disabled` a clearly inert control for a placeholder.
import { el } from './dom.js';

const VARIANTS = {
  primary:
    'bg-brand text-brand-contrast hover:bg-brand/90 active:scale-[0.98]',
  secondary:
    'border border-line bg-surface text-ink hover:bg-surface-raised active:scale-[0.98]',
  ghost: 'text-muted hover:text-ink',
};

export function button(label, { variant = 'primary', onClick, disabled = false, class: extra = '', attrs = {} } = {}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-pill px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100';
  const node = el(
    'button',
    {
      type: 'button',
      class: `${base} ${VARIANTS[variant] || VARIANTS.primary} ${extra}`.trim(),
      disabled,
      ...attrs,
    },
    [label],
  );
  if (onClick && !disabled) node.addEventListener('click', onClick);
  return node;
}
