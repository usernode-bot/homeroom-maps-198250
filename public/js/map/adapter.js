// The MapAdapter contract, and the registry that resolves one from the public
// map config. This file is the ONLY place that maps a `provider` name to an
// implementation.
//
// A screen (Home) depends only on this interface and never imports a renderer
// directly. That is what keeps the renderer swappable and keeps a future
// Search, Geocoding, Routing, Traffic or offline provider from leaking into a
// screen: each would be its own adapter registered here.
//
// Interface (all methods may reject with a MapError):
//   mount(container, { onState, onAttribution }) -> Promise<void>
//       Create the live map inside `container`. `onState(state)` reports
//       'ready' when tiles first paint. `onAttribution(string)` reports the
//       renderer's own attribution for the camera's current centre.
//   centerOn(latlng, zoom?)            -> move the camera
//   zoomIn() / zoomOut()               -> one zoom step
//   resetNorth()                       -> return bearing to 0
//   setStyle(styleUrl)                 -> swap basemap style, keep camera
//   setUserLocation({ lat, lng, accuracy }) -> marker + accuracy circle, or
//                                             clear it when passed null
//   setRoutes([{ coordinates: [[lng, lat], ...], selected }] | null)
//                                      -> draw route lines (Directions), or
//                                         clear them when passed null; data
//                                         set before the style is ready is
//                                         held and applied on load
//   setMarkers([{ lng, lat, label, selected }] | null)
//                                      -> draw numbered itinerary markers
//                                         (Trips), or clear them when null;
//                                         additive and backward compatible,
//                                         held until the style is ready like
//                                         setRoutes
//   setReports([{ id, type, lat, lng, effectiveStatus }] | null)
//                                      -> draw report pins (Community), or
//                                         clear them when passed null; held
//                                         and applied on load like routes
//   fitBounds({ west, south, east, north }, opts?) -> fit the camera to a
//                                         route's bounds (Directions)
//   capabilities                       -> { rotation, touchGestures, accuracyCircle }
//   destroy()                          -> remove the map and listeners

import { MapError, MapErrorKind, toMapError } from './errors.js';
import { createMapLibreAdapter } from './maplibre.js';
import { createUnsupportedAdapter } from './unsupported.js';

// Provider name -> adapter factory. The default keyless provider is MapLibre
// GL JS rendering OpenFreeMap tiles; the name is what `MAP_PROVIDER` selects
// server-side. Keys in this table match the `provider` field `/api/config`
// returns.
const REGISTRY = {
  maplibre: createMapLibreAdapter,
};

// Build the adapter named by the public config. A null/unknown provider, or a
// config with no usable style URL, yields the unsupported adapter rather than
// throwing, so Home always has something to render.
export function createAdapter(mapConfig) {
  if (!mapConfig || !mapConfig.configured || !mapConfig.styleUrl) {
    return createUnsupportedAdapter({
      kind: MapErrorKind.NOT_CONFIGURED,
      reason: 'Map is not configured yet.',
    });
  }
  const factory = REGISTRY[mapConfig.provider];
  if (!factory) {
    return createUnsupportedAdapter({
      kind: MapErrorKind.NOT_CONFIGURED,
      reason: 'Map is not configured yet.',
    });
  }
  // A device with no WebGL context cannot render any interactive map, so it
  // gets the unsupported-device adapter rather than a map that silently
  // fails to paint.
  if (!canRenderWebgl()) {
    return createUnsupportedAdapter({
      kind: MapErrorKind.UNSUPPORTED_DEVICE,
      reason: 'This device cannot show the interactive map.',
    });
  }
  try {
    return factory(mapConfig);
  } catch (err) {
    const error = toMapError(err, 'The map could not start.');
    return createUnsupportedAdapter({ kind: error.kind, reason: error.message });
  }
}

// True when this device can plausibly render a WebGL map at all. Kept here so
// both the adapter factory and Home can ask the same question.
export function canRenderWebgl() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

export { MapError, MapErrorKind };
