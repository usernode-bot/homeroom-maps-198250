// Region picker — the preset selection view of the Offline Areas screen.
//
// Rendered only while the effective capability is 'ready': the presets come
// from the server-resolved config, which withholds them entirely while the
// tile-provider permission gate (B2) is closed. Each row shows exactly what
// the spec requires a person to review before downloading: extent, zoom
// range, estimated size and the required attribution.
import { el } from '../dom.js';
import { button } from '../button.js';
import { t } from '../../i18n/index.js';
import { formatBytes } from './download-manager.js';

export function renderRegionPicker({ presets, onDownload }) {
  const rows = presets.map((preset) =>
    el(
      'div',
      {
        class: 'flex items-start justify-between gap-3 px-3 py-3',
        dataset: { offlinePreset: preset.id },
      },
      [
        el('div', { class: 'min-w-0 flex-1' }, [
          el('p', { class: 'truncate text-sm font-medium text-ink', text: preset.name }),
          el('p', {
            class: 'mt-0.5 text-xs text-muted',
            text: `${boundsLine(preset.bounds)} · ${t('offline.presetZoom', { min: preset.zoom.min, max: preset.zoom.max })}`,
          }),
          el('p', {
            class: 'mt-0.5 text-xs text-muted',
            text: t('offline.presetSize', { size: formatBytes(preset.estimatedBytes || 0) }),
          }),
          el('p', { class: 'mt-0.5 text-xs text-muted leading-relaxed', text: preset.attribution || '' }),
        ]),
        el('div', { class: 'shrink-0 self-center' }, [
          button(t('offline.download'), {
            variant: 'secondary',
            attrs: { 'data-offline-preset-download': preset.id },
            onClick: () => onDownload(preset),
          }),
        ]),
      ],
    ),
  );

  return el(
    'div',
    { class: 'divide-y divide-line rounded-card border border-line bg-surface', dataset: { offlineRegionPicker: 'true' } },
    rows,
  );
}

// The bounds rectangle in a compact, reviewable form. Two decimals is what
// the presets carry; the full numbers stay on the manifest.
function boundsLine(bounds) {
  const f = (n) => n.toFixed(2);
  // An en dash between the two coordinate pairs reads as a numeric range.
  return `${f(bounds.south)}, ${f(bounds.west)} – ${f(bounds.north)}, ${f(bounds.east)}`;
}