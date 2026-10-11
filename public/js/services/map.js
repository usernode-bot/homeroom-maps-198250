// Map service — the screen-facing controller over a MapAdapter.
//
// Home talks to this, never to the renderer. The service owns one adapter for
// the life of a mount, forwards the operations a screen needs (zoom, recentre,
// reset north, marker, style swap), normalises failures into MapErrors, and
// reports the map's own attribution. Which adapter it builds comes from the
// public map config alone; `provider` here is the config's provider name, and
// `isConfigured()` is the flag every earlier stage keyed on.
import { createAdapter, canRenderWebgl, MapErrorKind } from '../map/adapter.js';
import { createUnsupportedAdapter } from '../map/unsupported.js';
import { MapError, toMapError } from '../map/errors.js';

const UNSUPPORTED_REASON = 'This device cannot show the interactive map.';

export function isConfigured(mapConfig) {
  return Boolean(mapConfig && mapConfig.configured && mapConfig.styleUrl);
}

// Build a controller for one screen mount. `onState('ready'|'error', err?)`
// is called as the map settles; `onAttribution(string)` as the renderer's
// attribution changes.
export function createMapService(mapConfig, { onState, onAttribution, onTerrainError, force = null } = {}) {
  let adapter = null;
  let destroyed = false;
  // Remember the config this controller was built from so a retry or a theme
  // swap can rebuild without the caller re-reading global state.
  const config = mapConfig;

  function build() {
    if (force === 'unconfigured') {
      adapter = createAdapter(null);
    } else if (force === 'unsupported' || !canRenderWebgl()) {
      // The same adapter the real no-WebGL path yields, so the demo route
      // exercises the genuine unsupported-device state.
      adapter = createUnsupportedAdapter({
        kind: MapErrorKind.UNSUPPORTED_DEVICE,
        reason: UNSUPPORTED_REASON,
      });
    } else {
      adapter = createAdapter(mapConfig);
    }
    return adapter;
  }

  return {
    get provider() {
      return isConfigured(mapConfig) ? mapConfig.provider : null;
    },
    isConfigured: () => isConfigured(config),
    currentConfig: () => config,
    capabilities() {
      const base = adapter
        ? adapter.capabilities
        : {
            rotation: false,
            touchGestures: false,
            accuracyCircle: false,
            pitch: false,
            buildings: false,
            terrain: false,
          };
      // Phase 12A: the offline download capability rides alongside the
      // renderer's capabilities. It comes from the server config's
      // map.capabilities.offline (the B2 provider gate folded in), and is
      // false whenever the config does not say otherwise — fail closed.
      const offline = Boolean(config && config.capabilities && config.capabilities.offline);
      // Phase 12H: the 3D switches ride the same way. The config's pitch and
      // terrain switches NARROW what the renderer reports, never widen it —
      // an adapter claiming pitch on an unconfigured map still answers false.
      // Buildings pass through from the renderer alone: they are detected
      // from the live style, not advertised by configuration.
      const configCaps = (config && config.capabilities) || {};
      // Phase 12D: the live-traffic capability rides the same way, from
      // map.capabilities.traffic (the T1 provider gate folded in). False
      // whenever the config does not say otherwise — fail closed.
      const traffic = Boolean(configCaps.traffic);
      return {
        ...base,
        offline,
        traffic,
        pitch: Boolean(base.pitch) && Boolean(configCaps.pitch),
        terrain: Boolean(base.terrain) && Boolean(configCaps.terrain),
      };
    },

    async mount(container) {
      build();
      try {
        await adapter.mount(container, { onState, onAttribution, onTerrainError });
      } catch (err) {
        throw toMapError(err, 'The map could not be mounted.');
      }
    },

    centerOn(latlng, zoom) {
      adapter && adapter.centerOn(latlng, zoom);
    },
    zoomIn() {
      adapter && adapter.zoomIn();
    },
    zoomOut() {
      adapter && adapter.zoomOut();
    },
    resetNorth() {
      adapter && adapter.resetNorth();
    },
    // 3D camera + terrain (Phase 12H). Same forwarding contract as above: an
    // adapter that predates the method is simply skipped, so older renderer
    // builds stay usable.
    set3DEnabled(enabled) {
      if (adapter && typeof adapter.set3DEnabled === 'function') adapter.set3DEnabled(enabled);
    },
    setPitch(pitch) {
      if (adapter && typeof adapter.setPitch === 'function') adapter.setPitch(pitch);
    },
    setTerrainEnabled(enabled) {
      if (adapter && typeof adapter.setTerrainEnabled === 'function') {
        adapter.setTerrainEnabled(enabled);
      }
    },
    setStyle(styleUrl) {
      adapter && adapter.setStyle(styleUrl);
    },
    setUserLocation(location) {
      adapter && adapter.setUserLocation(location);
    },
    // Route rendering (Directions). The screen builds the feature list from
    // real provider geometry; the service only forwards it, keeping the
    // screen renderer-agnostic like every other operation.
    setRoutes(routes) {
      adapter && adapter.setRoutes(routes);
    },
    // Itinerary markers (Trips). Same forwarding contract as setRoutes; an
    // adapter that predates the method is simply skipped.
    setMarkers(markers) {
      if (adapter && typeof adapter.setMarkers === 'function') adapter.setMarkers(markers);
    },
    fitBounds(bounds, opts) {
      adapter && adapter.fitBounds(bounds, opts);
    },
    destroy() {
      destroyed = true;
      if (adapter) adapter.destroy();
      adapter = null;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

// Phase 12D: the Home traffic panel's state, derived fail-closed from the
// server config's `traffic` block. PURE and DOM-free so tests can prove the
// honesty property directly: it returns only i18n KEYS from a fixed
// allowlist — never strings, never traffic values, never anything that could
// be mistaken for live data. With the T1 gate closed (the only reachable
// state today) `enabled` is false and the panel says so plainly; the
// enabled branch exists so a future authorized provider change reuses this
// exact copy instead of inventing new wording.
export function trafficPanelState(traffic, { online = true } = {}) {
  const block = traffic && typeof traffic === 'object' ? traffic : {};
  // Fail closed: only an explicit `enabled: true` counts. A missing block, a
  // wrong shape or a stale snapshot all read as "not connected".
  const enabled = block.enabled === true;
  const lines = [];
  if (!enabled) lines.push('traffic.panelUnavailable');
  if (!online) lines.push('traffic.state.offline');
  // The community pointer shows in every state: community reports stay what
  // they are, and are never promoted to verified live traffic.
  lines.push('traffic.panelCommunity');
  if (!enabled) lines.push('traffic.panelRights');
  return { enabled, lines, checkAgain: 'traffic.checkAgain' };
}

export { MapError, MapErrorKind };
