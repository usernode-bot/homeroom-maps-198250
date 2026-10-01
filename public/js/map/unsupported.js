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
    setStyle() {},
    setUserLocation() {},
    setRoutes() {},
    fitBounds() {},
    destroy() {},
  };
}
