// Offline Areas — the Phase 12A screen. One job: show what is honestly on
// this device, and let a person download a preset region when — and only
// when — the capability gate says downloads are permitted.
//
// The screen has three top-level states, keyed on the resolved capability
// (services/offline-capability.js):
//
//   capability_unavailable  the tile-provider permission gate is closed
//                           (blocker B2). The explanation and a Check again
//                           action render, any already-stored regions are
//                           listed with Delete, and there is NO download
//                           affordance anywhere.
//   unsupported_browser     this device cannot hold offline regions (no
//                           service worker or IndexedDB). Explained plainly.
//   ready                   the region picker plus the person's regions,
//                           with live progress, resume, cancel and delete.
//
// Every number on this screen is real: tile counts and bytes come from the
// local store, progress comes from the download orchestrator, and a region
// only reads as complete when the orchestrator verified it. A download that
// was interrupted (page closed mid-run, cancelled, failed) never renders as
// complete.
import { el } from '../components/dom.js';
import { button } from '../components/button.js';
import { loading } from '../components/loading.js';
import { emptyState } from '../components/empty-state.js';
import { confirmAction } from '../components/saved/dialogs.js';
import { renderRegionPicker } from '../components/offline/region-picker.js';
import {
  formatBytes,
  renderDownloadingRow,
  renderResultRow,
  renderCompleteRow,
} from '../components/offline/download-manager.js';
import { resolveOfflineCapability, OFFLINE_STAGE } from '../services/offline-capability.js';
import { createTileStore } from '../services/offline-tiles.js';
import { createRegionService } from '../services/offline-regions.js';
import { createDownloadManager, DOWNLOAD_STATUS } from '../services/offline-download.js';
import { announceAllowedHosts } from '../services/offline-registration.js';
import { getState } from '../state.js';
import { fetchConfig } from '../api.js';
import { t } from '../i18n/index.js';

export async function render(ctx) {
  const host = el('div', { class: 'flex flex-col gap-3', dataset: { offlineHost: 'true' } });
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: t('offline.title') }),
    el('p', { class: 'text-sm text-muted leading-relaxed', text: t('offline.intro') }),
    host,
  );

  host.dataset.offlineState = 'loading';
  host.replaceChildren(loading({ label: t('offline.loading') }));

  // Config arrives through the shell's boot (loadMeta); read it defensively
  // and refetch if this screen opened before it landed.
  let config = getState().config;
  if (!config || !config.map) {
    try {
      config = await fetchConfig();
    } catch {
      config = null;
    }
  }

  let capability;
  try {
    capability = resolveOfflineCapability({ config });
  } catch {
    capability = null;
  }
  if (!capability) {
    // Fail closed: an unresolvable capability is a blocked capability.
    capability = {
      stage: OFFLINE_STAGE.PROVIDER_BLOCKED,
      blocker: 'B2',
      maxStorageBytes: 0,
      presets: [],
    };
  }

  const store = createTileStore({});
  const regionService = createRegionService({ store });
  const downloadManager = createDownloadManager({ store });
  let regions = await safeList(store);

  // Reconcile: a manifest still marked 'downloading' with no active run is
  // the footprint of a page that closed mid-download. It is interrupted, and
  // the record now says so — the honest state, not a stuck spinner.
  if (!downloadManager.active) {
    for (const region of regions.filter((r) => r && r.status === 'downloading')) {
      try {
        await regionService.update(region.id, {
          status: 'interrupted',
          interruptedAt: new Date().toISOString(),
        });
        region.status = 'interrupted';
      } catch {
        /* a failed reconcile renders the region as stored, never as complete */
      }
    }
  }

  if (capability.stage === OFFLINE_STAGE.UNSUPPORTED_BROWSER) {
    renderUnsupported();
  } else if (capability.stage === OFFLINE_STAGE.PROVIDER_BLOCKED) {
    renderBlocked();
  } else {
    await renderReady();
  }

  // ---- the blocked state (the B2 gate is closed) ----

  function renderBlocked() {
    host.dataset.offlineState = 'capability_unavailable';
    const children = [
      el(
        'div',
        {
          class: 'rounded-card border border-line bg-surface px-4 py-4',
          dataset: { offlineNotice: 'provider_blocked' },
        },
        [
          el('p', { class: 'text-sm font-semibold text-ink', text: t('offline.blockedTitle') }),
          el('p', {
            class: 'mt-1 text-sm text-muted leading-relaxed',
            text: t('offline.blockedBody'),
          }),
          el('div', { class: 'mt-3' }, [
            button(t('offline.checkAgain'), {
              variant: 'secondary',
              attrs: { 'data-offline-check': 'true' },
              onClick: () => render(ctx),
            }),
          ]),
        ],
      ),
    ];
    if (regions.length) children.push(storedRegionsCard());
    host.replaceChildren(...children);
  }

  // ---- the unsupported-browser state ----

  function renderUnsupported() {
    host.dataset.offlineState = 'unsupported_browser';
    const children = [
      el(
        'div',
        {
          class: 'rounded-card border border-line bg-surface px-4 py-4',
          dataset: { offlineNotice: 'unsupported_browser' },
        },
        [
          el('p', { class: 'text-sm font-semibold text-ink', text: t('offline.unsupportedTitle') }),
          el('p', {
            class: 'mt-1 text-sm text-muted leading-relaxed',
            text: t('offline.unsupportedBody'),
          }),
        ],
      ),
    ];
    if (regions.length) children.push(storedRegionsCard());
    host.replaceChildren(...children);
  }

  // The stored-regions card used by the blocked and unsupported states: real
  // rows, real bytes, Delete only. No download affordance anywhere near it.
  function storedRegionsCard() {
    return el('div', { class: 'flex flex-col gap-2', dataset: { offlineStored: 'true' } }, [
      el('h2', { class: 'text-base font-semibold text-ink', text: t('offline.storedTitle') }),
      el(
        'div',
        { class: 'divide-y divide-line rounded-card border border-line bg-surface' },
        sortedRegions().map((region) =>
          region.status === 'complete'
            ? renderCompleteRow({ region, usage: null, onDelete: deleteRegionFromBlocked })
            : renderResultRow({ region, usage: null, onTryAgain: null, onDelete: deleteRegionFromBlocked }),
        ),
      ),
    ]);
  }

  async function deleteRegionFromBlocked(region) {
    const confirmed = await confirmDelete(region);
    if (!confirmed) return;
    try {
      await store.deleteRegion(region.id);
      regions = await safeList(store);
    } catch {
      /* the row stays; nothing was deleted, so nothing is pretended */
    }
    // Re-render whichever blocked state is on screen.
    if (host.dataset.offlineState === 'capability_unavailable') renderBlocked();
    else if (host.dataset.offlineState === 'unsupported_browser') renderUnsupported();
  }

  async function confirmDelete(region) {
    try {
      return await confirmAction({
        title: t('offline.deleteTitle'),
        message: t('offline.deleteBody', { name: region.name }),
        confirmLabel: t('offline.delete'),
      });
    } catch {
      return false;
    }
  }

  // ---- the ready state: picker, live progress, resume, delete ----

  async function renderReady() {
    const progressByRegion = new Map();
    let activeRun = null;
    let totalBytes = 0;

    const pickerSection = el('div', { class: 'flex flex-col gap-2' }, [
      el('h2', { class: 'text-base font-semibold text-ink', text: t('offline.chooseRegion') }),
      el('p', {
        class: 'text-sm text-muted leading-relaxed',
        text: t('offline.chooseRegionBody'),
      }),
      renderRegionPicker({
        presets: capability.presets || [],
        onDownload: (preset) => startDownload(preset),
      }),
    ]);

    const areasSection = el('div', { class: 'flex flex-col gap-2', dataset: { offlineAreas: 'true' } });

    function onProgress(payload) {
      if (!payload || !payload.regionId) return;
      progressByRegion.set(payload.regionId, payload);
      const known = regions.find((r) => r.id === payload.regionId);
      if (!known) {
        // The orchestrator created the manifest mid-run; pull it in so the
        // row can render from the real record.
        regionService
          .get(payload.regionId)
          .then((region) => {
            if (region && !regions.some((r) => r.id === region.id)) {
              regions.push(region);
              renderAreas();
            }
          })
          .catch(() => {});
        return;
      }
      const row = areasSection.querySelector(`[data-offline-region="${payload.regionId}"]`);
      if (row && row.dataset.offlineRegionState === 'downloading') {
        row.replaceWith(
          renderDownloadingRow({ region: known, progress: payload, onCancel: cancelActive }),
        );
      }
    }

    function cancelActive() {
      if (activeRun) activeRun.cancel();
    }

    async function startDownload(preset) {
      if (activeRun) return;
      const mapConfig = (config && config.map) || {};
      // Resume: a stored interrupted/failed region covering the same preset
      // continues instead of starting over; the orchestrator skips tiles it
      // already verified as stored.
      const existing = regions.find(
        (r) =>
          (r.status === 'interrupted' || r.status === 'failed') &&
          r.name === preset.name &&
          sameBounds(r.bounds, preset.bounds) &&
          sameZoom(r.zoom, preset.zoom),
      );
      host.dataset.offlineState = 'downloading';
      activeRun = { cancel: () => {} };
      try {
        const result = await downloadManager.start({
          capability,
          preset,
          provider: mapConfig.provider || '',
          styleUrl: mapConfig.styleUrl || '',
          attribution: mapConfig.attribution || '',
          maxStorageBytes: capability.maxStorageBytes || 0,
          onProgress,
          regionService,
          existingRegion: existing || null,
        });
        if (result && result.status === DOWNLOAD_STATUS.BLOCKED) {
          // The gate refused at the last moment: nothing was downloaded.
          renderBlocked();
          return;
        }
        if (result && result.status === DOWNLOAD_STATUS.COMPLETED && Array.isArray(result.hosts)) {
          // Hand the run's real hosts to the worker's allowlist (it also
          // derives hosts from the stored resources itself).
          announceAllowedHosts(result.hosts);
        }
      } finally {
        activeRun = null;
        progressByRegion.clear();
        regions = await safeList(store);
        host.dataset.offlineState = 'ready';
        renderAreas();
      }
    }

    async function tryAgain(region) {
      if (activeRun) return;
      const mapConfig = (config && config.map) || {};
      host.dataset.offlineState = 'downloading';
      activeRun = { cancel: () => {} };
      try {
        await downloadManager.start({
          capability,
          preset: {
            id: region.name,
            name: region.name,
            bounds: region.bounds,
            zoom: region.zoom,
            format: (region.artifacts && region.artifacts[0] && region.artifacts[0].format) || 'mvt',
          },
          provider: region.provider || (mapConfig.provider || ''),
          styleUrl: region.styleUrl || mapConfig.styleUrl || '',
          attribution: region.attribution || mapConfig.attribution || '',
          maxStorageBytes: capability.maxStorageBytes || 0,
          onProgress,
          regionService,
          existingRegion: region,
        });
      } finally {
        activeRun = null;
        progressByRegion.clear();
        regions = await safeList(store);
        host.dataset.offlineState = 'ready';
        renderAreas();
      }
    }

    async function deleteRegion(region) {
      const confirmed = await confirmDelete(region);
      if (!confirmed) return;
      try {
        await store.deleteRegion(region.id);
        regions = await safeList(store);
      } catch {
        /* the row stays; nothing was deleted, so nothing is pretended */
      }
      renderAreas();
    }

    function renderAreas() {
      const sorted = sortedRegions();
      const children = [];
      if (!sorted.length) {
        children.push(
          emptyState({
            title: t('offline.emptyTitle'),
            description: t('offline.emptyBody'),
          }),
        );
      } else {
        children.push(el('h2', { class: 'text-base font-semibold text-ink', text: t('offline.areasTitle') }));
        children.push(
          el(
            'div',
            { class: 'divide-y divide-line rounded-card border border-line bg-surface' },
            sorted.map((region) => regionRow(region)),
          ),
        );
        children.push(
          el('p', {
            class: 'text-xs text-muted',
            dataset: { offlineStorage: 'true' },
            text: capability.maxStorageBytes
              ? t('offline.storageUsed', { used: formatBytes(totalBytes), cap: formatBytes(capability.maxStorageBytes) })
              : '',
          }),
        );
      }
      areasSection.replaceChildren(...children);
    }

    function regionRow(region) {
      if (region.status === 'downloading' && progressByRegion.has(region.id)) {
        return renderDownloadingRow({
          region,
          progress: progressByRegion.get(region.id),
          onCancel: cancelActive,
        });
      }
      if (region.status === 'complete') {
        return renderCompleteRow({ region, usage: null, onDelete: deleteRegion });
      }
      // failed / interrupted: a result row with Try again for interrupted
      // runs and Delete always. Never a completed status.
      return renderResultRow({
        region,
        usage: null,
        onTryAgain: region.status === 'interrupted' ? tryAgain : null,
        onDelete: deleteRegion,
      });
    }

    host.dataset.offlineState = 'ready';
    host.replaceChildren(pickerSection, areasSection);

    // The real storage figure, then the real region list.
    try {
      const usage = await store.totalUsage();
      totalBytes = (usage && usage.bytes) || 0;
    } catch {
      totalBytes = 0;
    }
    renderAreas();
  }

  // ---- helpers ----

  function sortedRegions() {
    return [...regions].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  function sameBounds(a, b) {
    return Boolean(
      a && b && ['west', 'south', 'east', 'north'].every((k) => Number(a[k]) === Number(b[k])),
    );
  }

  function sameZoom(a, b) {
    return Boolean(a && b && Number(a.min) === Number(b.min) && Number(a.max) === Number(b.max));
  }
}

async function safeList(store) {
  try {
    return (await store.listRegions()) || [];
  } catch {
    return [];
  }
}