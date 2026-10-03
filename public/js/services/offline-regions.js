// Offline region lifecycle — create, list and delete regions in the local
// store. The RegionManifest v1 contract is validated and frozen server-side
// (offline/region-manifest.js); this service is the browser-side producer
// that builds manifests from server-resolved presets and keeps the local
// records honest: a region is created with status 'downloading' before any
// byte is fetched, and only the download orchestrator ever marks it
// 'complete' — after every planned artifact is stored and verified.
'use strict';

export function createRegionService({ store, idGen, now = () => new Date().toISOString() } = {}) {
  const newId = idGen || defaultId;

  function defaultId() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID().replace(/[^A-Za-z0-9-]/g, '');
      }
    } catch {
      /* fall through to the deterministic generator */
    }
    // Non-crypto fallback (old WebViews): still conforms to the id contract.
    return 'r' + String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
  }

  return {
    // Build and persist a region manifest for one server-resolved preset.
    // The manifest plans exactly one `tiles` artifact (Phase 12A); the
    // offline search and routing streams add `index`/`graph` artifacts to
    // their own regions under the same contract.
    async create({ preset, provider, styleUrl, attribution, tileCount }) {
      if (!preset || !preset.id || !preset.bounds || !preset.zoom) {
        throw new Error('A region preset with bounds and a zoom range is required.');
      }
      const manifest = {
        version: 1,
        id: newId(),
        name: preset.name || preset.id,
        provider: String(provider || ''),
        styleUrl: String(styleUrl || ''),
        attribution: String(attribution || ''),
        bounds: { ...preset.bounds },
        zoom: { ...preset.zoom },
        artifacts: [
          {
            kind: 'tiles',
            format: preset.format || 'mvt',
            status: 'pending',
            ...(Number.isInteger(tileCount) ? { tileCount } : {}),
          },
        ],
        status: 'downloading',
        createdAt: now(),
      };
      // Minimal producer-side sanity; the full v1 validation lives
      // server-side and is what the contract tests pin.
      if (!/^[A-Za-z0-9-]{1,64}$/.test(manifest.id)) {
        throw new Error('Generated region id does not conform to the manifest contract.');
      }
      return store.putRegion(manifest);
    },

    list() {
      return store.listRegions();
    },

    get(id) {
      return store.getRegion(id);
    },

    update(id, patch) {
      return store.updateRegion(id, patch);
    },

    usage(id) {
      return store.regionUsage(id);
    },

    totalUsage() {
      return store.totalUsage();
    },

    quota() {
      return store.estimateQuota();
    },

    // Delete a region and everything stored for it. The online map is not
    // touched: this is purely device-local storage management.
    async remove(id) {
      await store.deleteRegion(id);
      return true;
    },
  };
}