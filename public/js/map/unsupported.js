// A no-op adapter for the states where no live map is possible: the device
// has no WebGL context or the renderer failed to load (unsupported device), or
// no provider is configured. It satisfies the same interface as a real
// adapter so Home renders one code path, and its methods are inert.
import { MapError } from './errors.js';

export function createUnsupportedAdapter({ kind, reason }) {
  return {
    capabilities: {
      rotation: false,
      touchGestures: false,
      accuracyCircle: false,
      // Phase 12H: no live map, no 3D — every flag stays false so the screen
      // never renders a 3D control in an unsupported state.
      pitch: false,
      buildings: false,
      terrain: false,
    },
    unavailableReason: reason,
    unavailableKind: kind,
    async mount() {
      throw new MapError(kind, reason);
    },
    centerOn() {},
    zoomIn() {},
    zoomOut() {},
    resetNorth() {},
    setBearing() {},
    // Phase 12H: inert 3D methods, same contract as the real adapter.
    set3DEnabled() {},
    setPitch() {},
    setTerrainEnabled() {},
    setStyle() {},
    setUserLocation() {},
    setRoutes() {},
    setMarkers() {},
    setReports() {},
    fitBounds() {},
    destroy() {},
  };
}
