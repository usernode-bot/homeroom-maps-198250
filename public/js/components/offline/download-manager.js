// Download manager component — the run-state rows of the Offline Areas
// screen: active progress, failure or interruption, and completion.
//
// Every state here reports REAL values from the download orchestrator and
// the local store: real tile counts, real bytes, real timestamps. There is
// no estimated progress, no optimistic completion, and an interrupted or
// failed run always renders as one, never as a completed region.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

// The active download row: region name, phase, real tile progress and byte
// progress, plus the one primary action while a download is running: Cancel.
export function renderDownloadingRow({ region, progress, onCancel }) {
  const done = progress ? progress.done : 0;
  const total = progress ? progress.total : 0;
  const bytes = progress ? progress.bytes : 0;
  return el(
    'div',
    { class: 'px-3 py-3', dataset: { offlineRegion: region.id, offlineRegionState: 'downloading' } },
    [
      el('div', { class: 'flex items-start justify-between gap-3' }, [
        el('div', { class: 'min-w-0 flex-1' }, [
          el('p', { class: 'truncate text-sm font-medium text-ink', text: region.name }),
          el('p', {
            class: 'mt-0.5 text-xs text-muted',
            text: progress && progress.phase === 'resources'
              ? t('offline.preparing')
              : t('offline.progressTiles', { done, total }),
          }),
          el('p', { class: 'mt-0.5 text-xs text-muted', text: t('offline.downloadedBytes', { size: formatBytes(bytes) }) }),
        ]),
        el('div', { class: 'shrink-0 self-center flex items-center gap-2' }, [
          el('div', { class: 'h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand', role: 'status', 'aria-label': t('offline.downloading') }),
          button(t('offline.cancel'), {
            variant: 'secondary',
            attrs: { 'data-offline-cancel': 'true' },
            onClick: () => onCancel && onCancel(),
          }),
        ]),
      ]),
      el('div', { class: 'mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-raised' }, [
        el('div', {
          class: 'h-full rounded-full bg-brand transition-all',
          style: `width: ${total ? Math.min(100, Math.round((done / total) * 100)) : 0}%`,
        }),
      ]),
    ],
  );
}

// A failed or interrupted run. The row names what happened and offers the
// two honest ways out: resume with Try again, or remove the partial data
// with Delete. It never renders a completed status.
export function renderResultRow({ region, usage, onTryAgain, onDelete }) {
  const interrupted = region.status === 'interrupted';
  const storageLimit = region.failedReason === 'storage_limit';
  return el(
    'div',
    { class: 'px-3 py-3', dataset: { offlineRegion: region.id, offlineRegionState: region.status } },
    [
      el('div', { class: 'flex items-start justify-between gap-3' }, [
        el('div', { class: 'min-w-0 flex-1' }, [
          el('p', { class: 'truncate text-sm font-medium text-ink', text: region.name }),
          el('p', {
            class: 'mt-0.5 text-xs font-medium text-ink',
            text: interrupted ? t('offline.interruptedTitle') : storageLimit ? t('offline.storageLimitTitle') : t('offline.failedTitle'),
          }),
          el('p', {
            class: 'mt-0.5 text-xs text-muted leading-relaxed',
            text: interrupted
              ? t('offline.interruptedBody')
              : storageLimit
                ? t('offline.storageLimitBody')
                : t('offline.failedBody'),
          }),
          usage && usage.bytes
            ? el('p', {
                class: 'mt-0.5 text-xs text-muted',
                text: t('offline.downloadedBytes', { size: formatBytes(usage.bytes) }),
              })
            : null,
        ]),
        el('div', { class: 'shrink-0 flex gap-2 self-center' }, [
          interrupted ? button(t('offline.tryAgain'), {
            variant: 'secondary',
            attrs: { 'data-offline-retry': region.id },
            onClick: () => onTryAgain && onTryAgain(region),
          }) : null,
          button(t('offline.delete'), {
            variant: 'secondary',
            class: 'text-danger',
            attrs: { 'data-offline-delete': region.id },
            onClick: () => onDelete && onDelete(region),
          }),
        ]),
      ]),
    ],
  );
}

// A verified, complete region: what is really stored, when it finished, and
// the way to remove it.
export function renderCompleteRow({ region, usage, onDelete }) {
  const completed = usage && usage.tiles ? usage.tiles.count : region.tileCount || 0;
  const bytes = usage ? usage.bytes : region.byteSize || 0;
  return el(
    'div',
    { class: 'flex items-start justify-between gap-3 px-3 py-3', dataset: { offlineRegion: region.id, offlineRegionState: 'complete' } },
    [
      el('div', { class: 'flex min-w-0 flex-1 items-start gap-3' }, [
        icon('check', { class: 'mt-0.5 h-5 w-5 shrink-0 text-brand' }),
        el('div', { class: 'min-w-0 flex-1' }, [
          el('p', { class: 'truncate text-sm font-medium text-ink', text: region.name }),
          el('p', { class: 'mt-0.5 text-xs font-medium text-ink', text: t('offline.readyOffline') }),
          el('p', {
            class: 'mt-0.5 text-xs text-muted',
            text: t('offline.regionDetail', { tiles: completed, size: formatBytes(bytes) }),
          }),
          region.completedAt
            ? el('p', {
                class: 'mt-0.5 text-xs text-muted',
                text: t('offline.completedOn', { date: new Date(region.completedAt).toLocaleDateString() }),
              })
            : null,
        ]),
      ]),
      el('div', { class: 'shrink-0 self-center' }, [
        button(t('offline.delete'), {
          variant: 'secondary',
          class: 'text-danger',
          attrs: { 'data-offline-delete': region.id },
          onClick: () => onDelete && onDelete(region),
        }),
      ]),
    ],
  );
}