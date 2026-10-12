// Selected search place → map camera view. Pure, import-free: the Home screen
// asks it what a chosen search result means for the map (centre, zoom, the one
// marker), and it answers null when the place carries no usable position, so
// the screen can leave the camera alone and say so under the map.
//
// Search results use lat/lon (search/normalize.js and the offline results);
// the adapter's centerOn and setMarkers take lat/lng. This is where the two
// shapes meet — lon becomes lng here, never swapped.
'use strict';

// Street-level zoom, the same one the "Lokasi saya" camera move uses.
export const SELECTED_PLACE_ZOOM = 14;

export function selectedPlaceView(place) {
  if (!place || typeof place !== 'object') return null;
  const lat = Number(place.lat);
  const lng = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    center: { lat, lng },
    zoom: SELECTED_PLACE_ZOOM,
    markers: [{ lat, lng, label: '' }],
  };
}
