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
export function createMapService(mapConfig, { onState, onAttribution, force = null } = {}) {
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
      return adapter ? adapter.capabilities : { rotation: false, touchGestures: false, accuracyCircle: false };
    },

    async mount(container) {
      build();
      try {
        await adapter.mount(container, { onState, onAttribution });
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

export { MapError, MapErrorKind };
