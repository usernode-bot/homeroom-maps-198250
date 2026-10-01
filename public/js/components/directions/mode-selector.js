// Travel mode selector — chips for the modes the ACTIVE routing provider
// genuinely serves, driven by the routing capabilities in /api/config.
//
// Unsupported modes are NOT shown as functional. They are listed in a muted
// note below the chips with the reason, so the limit is explained rather
// than pretended (the alternative — hiding them — would leave the note
// unread, but a mode chip that does nothing would be worse).
import { el } from '../dom.js';
import { TRAVEL_MODES } from '../../services/routing-core.js';

export function modeSelector({ supportedModes, unsupportedModes, providerLabel, mode, onModeChange }) {
  const chips = supportedModes.map((m) =>
    el(
      'button',
      {
        type: 'button',
        class: [
          'rounded-pill px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          m === mode
            ? 'bg-brand text-brand-contrast'
            : 'border border-line bg-surface text-ink hover:bg-surface-raised',
        ].join(' '),
        'aria-pressed': m === mode ? 'true' : 'false',
        dataset: { travelMode: m },
      },
      [TRAVEL_MODES[m]],
    ),
  );
  for (const chip of chips) {
    chip.addEventListener('click', () => onModeChange(chip.dataset.travelMode));
  }

  const note = unsupportedModes.length
    ? el('p', {
        class: 'text-xs text-muted leading-relaxed',
        dataset: { modesNote: 'true' },
      }, [
        `Not offered by the ${providerLabel || 'routing'} provider: ${unsupportedModes.map((m) => TRAVEL_MODES[m]).join(', ')}.`,
      ])
    : null;

  return el('div', { class: 'flex flex-col gap-1.5', dataset: { modeSelector: 'true' } }, [
    el('p', { class: 'text-xs font-medium uppercase tracking-wide text-muted' }, ['Travel mode']),
    el('div', { class: 'flex flex-wrap gap-2' }, chips),
    note,
  ]);
}
