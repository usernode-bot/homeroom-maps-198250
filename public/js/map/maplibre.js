// MapLibre GL JS adapter — the renderer behind the MapAdapter abstraction.
//
// The renderer is vendored into the image at build time (see the `build:map`
// script and the Dockerfile) and served same-origin from /vendor/maplibre/.
// No hostname is written here: the style/tile source comes entirely from the
// public map config, so switching the tile host is a configuration change,
// not a code change.
//
// The renderer is loaded lazily, the first time Home mounts a map, and only
// as a classic script: the vendored bundle is a UMD build that publishes
// `window.maplibregl`, so it must not be imported as an ES module.
import {
  MapError,
  MapErrorKind,
  toMapError,
} from './errors.js';
import { REPORT_TYPES, reportPinImage } from './report-icons.js';

// Same-origin, relative to this app. This path is produced by `npm run
// build:map`, never committed.
const SCRIPT_URL = '/vendor/maplibre/maplibre-gl.js';
const CSS_URL = '/vendor/maplibre/maplibre-gl.css';

// The world view Home opens on: the whole globe, slightly above the equator.
const WORLD_CENTER = [0, 20];
const WORLD_ZOOM = 1;

const MARKER_COLOR = '#4f46e5';

// Route line colours. The selected route is the app's brand indigo (the same
// colour the user-location marker uses); the casing underneath keeps it
// legible over every basemap, and alternatives are muted grey so the primary
// route always reads first.
const ROUTE_COLOR = '#4f46e5';
const ROUTE_CASING_COLOR = '#312e81';
const ROUTE_ALTERNATIVE_COLOR = '#6b7280';

// Report pins draw the type glyph in the pin's background colour. Expired
// reports keep their type but turn grey, so the feed and the map read the
// same story (the same effectiveStatus the server derives).

let loaderPromise = null;

// The rasterized pin images — one accent and one expired-grey variant per
// report type, generated once per device pixel ratio through the SVG
// engine. A failed generation is not cached: the next map that mounts
// tries again.
let reportImagesPromise = null;

function reportImages() {
  if (reportImagesPromise) return reportImagesPromise;
  const pixelRatio = window.devicePixelRatio || 1;
  reportImagesPromise = Promise.all(
    REPORT_TYPES.flatMap((type) => [
      reportPinImage(type, { pixelRatio }).then((img) => [type, img]),
      reportPinImage(type, { expired: true, pixelRatio }).then((img) => [`${type}-expired`, img]),
    ]),
  ).then((entries) => Object.fromEntries(entries));
  reportImagesPromise.catch(() => {
    reportImagesPromise = null;
  });
  return reportImagesPromise;
}

// Load the vendored renderer exactly once, whoever asks first. Resolves with
// the `maplibregl` global. Rejects with an UNSUPPORTED_DEVICE MapError if the
// script cannot be fetched or does not publish its global — a renderer that
// failed to load would otherwise render a silently blank map, so it must
// surface as the unsupported-device state.
function loadRenderer() {
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise((resolve, reject) => {
    const existing = window.maplibregl;
    if (existing && typeof existing.Map === 'function') {
      return resolve(existing);
    }
    // The stylesheet, once. The renderer needs it for controls and canvas
    // positioning; without it the map has no size.
    if (!document.querySelector('link[data-maplibre-css]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      link.dataset.maplibreCss = 'true';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.dataset.maplibreScript = 'true';
    script.onload = () => {
      if (window.maplibregl && typeof window.maplibregl.Map === 'function') {
        resolve(window.maplibregl);
      } else {
        reject(
          new MapError(
            MapErrorKind.UNSUPPORTED_DEVICE,
            'This device cannot show the interactive map.',
            { detail: 'renderer global missing after load' },
          ),
        );
      }
    };
    script.onerror = () => {
      reject(
        new MapError(
          MapErrorKind.UNSUPPORTED_DEVICE,
          'This device cannot show the interactive map.',
          { detail: `failed to load ${SCRIPT_URL}` },
        ),
      );
    };
    document.head.appendChild(script);
  });
  // A failed first attempt must not poison every later mount (the retry
  // button re-mounts): clear the cache so the next call can try again.
  loaderPromise.catch(() => {
    loaderPromise = null;
  });
  return loaderPromise;
}

export function createMapLibreAdapter(mapConfig) {
  const styleUrl = mapConfig.styleUrl;
  const styleUrlDark = mapConfig.styleUrlDark || null;

  let map = null;
  let maplibregl = null;
  let destroyed = false;
  let marker = null;
  let accuracySource = false;
  let resizeObserver = null;
  let readyReported = false;
  let routes = null; // the last setRoutes() payload, applied when layers exist
  let routeLayersReady = false;
  let reports = null; // the last setReports() payload, applied when layers exist
  let reportLayersReady = false;

  const capabilities = {
    rotation: true,
    touchGestures: true,
    accuracyCircle: true,
  };

  function emitError(onState, error) {
    if (destroyed) return;
    if (onState) onState('error', error);
  }

  // Classify whatever the renderer reports into a MapError kind. Tile and
  // style requests that the provider rejects (auth, quota, malformed style)
  // are PROVIDER failures; a fetch that never reached the network is NETWORK.
  function classifyError(event) {
    const err = (event && event.error) || event;
    const status = err && (err.status || (err.response && err.response.status));
    const detail = (err && (err.message || String(err))) || '';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return new MapError(MapErrorKind.NETWORK, NETWORK_MESSAGE, { detail });
    }
    if (status === 401 || status === 403 || status === 429) {
      return new MapError(
        MapErrorKind.PROVIDER,
        'The map provider refused this request. It may be rate limited or need a key.',
        { detail: detail + (status ? ` (HTTP ${status})` : '') },
      );
    }
    if (status && status >= 400) {
      return new MapError(
        MapErrorKind.PROVIDER,
        'The map provider could not serve the map style.',
        { detail: detail + ` (HTTP ${status})` },
      );
    }
    if (/Failed to fetch|NetworkError|load failed|ERR_/i.test(detail)) {
      return new MapError(MapErrorKind.NETWORK, NETWORK_MESSAGE, { detail });
    }
    return new MapError(
      MapErrorKind.STYLE_ERROR,
      'The map style could not be loaded.',
      { detail },
    );
  }

  function readAttribution(onAttribution) {
    if (!onAttribution || !map) return;
    const node = map
      .getContainer()
      .querySelector('.maplibregl-ctrl-attrib-inner');
    if (node && node.textContent) onAttribution(node.textContent.trim());
  }

  async function mount(container, { onState, onAttribution } = {}) {
    if (destroyed) throw new Error('adapter destroyed');
    maplibregl = await loadRenderer();
    if (destroyed) return;

    try {
      map = new maplibregl.Map({
        container,
        style: styleUrl,
        center: WORLD_CENTER,
        zoom: WORLD_ZOOM,
        minZoom: 0,
        maxZoom: 22,
        attributionControl: true,
        // Rotation, touch gestures and keyboard panning are on by default;
        // they are declared explicitly so the capability flags below are
        // self-evidently true rather than implied.
        dragRotate: true,
        touchZoomRotate: true,
        keyboard: true,
        doubleClickZoom: true,
        scrollZoom: true,
      });
    } catch (err) {
      throw new MapError(
        MapErrorKind.UNSUPPORTED_DEVICE,
        'This device cannot show the interactive map.',
        { detail: err && err.message, cause: err },
      );
    }

    map.on('error', (event) => {
      // Style/tile request failures after the first successful paint are
      // reported as provider errors; the first failure is the one that
      // decides Home's state, so only report while not yet ready.
      const error = classifyError(event);
      if (error.detail) console.warn('[map] ' + error.kind + ': ' + error.detail);
      if (!readyReported) emitError(onState, error);
    });

    map.on('load', () => {
      if (destroyed) return;
      ensureAccuracyLayer();
      if (routes) applyRoutes(routes);
      if (reports) applyReports(reports);
      readAttribution(onAttribution);
      if (onState && !readyReported) {
        readyReported = true;
        onState('ready');
      }
    });

    map.on('styledata', () => {
      if (destroyed) return;
      readAttribution(onAttribution);
      // A style swap (the theme change does one) drops every custom source
      // and layer. When a route is showing, re-add the route layers so the
      // route survives the swap. The same applies to report pins.
      if (map.isStyleLoaded() && routes) {
        routeLayersReady = false;
        applyRoutes(routes);
      }
      if (map.isStyleLoaded() && reports) {
        reportLayersReady = false;
        applyReports(reports);
      }
    });

    // Keep the canvas sized to its frame (theme/text reflow, keyboard, the
    // shell's own resizes).
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (map && !destroyed) map.resize();
      });
      resizeObserver.observe(container);
    }
  }

  function ensureAccuracyLayer() {
    if (!map || accuracySource) return;
    map.addSource('user-accuracy', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'user-accuracy-fill',
      type: 'fill',
      source: 'user-accuracy',
      paint: { 'fill-color': MARKER_COLOR, 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'user-accuracy-outline',
      type: 'line',
      source: 'user-accuracy',
      paint: { 'line-color': MARKER_COLOR, 'line-opacity': 0.5, 'line-width': 1 },
    });
    accuracySource = true;
  }

  // ── route rendering ────────────────────────────────────────────────────
  //
  // One GeoJSON source carries every route line; three line layers style it
  // (casing under the selected route, muted alternatives, selected on top).
  // The layers are inserted BEFORE the style's first symbol layer so place
  // labels stay readable above the route.

  function applyRoutes(routeList) {
    if (!map || !map.isStyleLoaded()) return;
    if (!ensureRouteLayers()) return;
    try {
      map.getSource('hm-routes').setData(routesFeatureCollection(routeList));
    } catch (err) {
      console.warn('[map] route render failed: ' + (err && err.message));
    }
  }

  function clearRouteSource() {
    try {
      map.getSource('hm-routes').setData({ type: 'FeatureCollection', features: [] });
    } catch {
      /* the source is already gone (style swapped) */
    }
  }

  function ensureRouteLayers() {
    if (!map || routeLayersReady || !map.isStyleLoaded()) return false;
    try {
      if (!map.getSource('hm-routes')) {
        map.addSource('hm-routes', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
      }
      const style = map.getStyle();
      const firstSymbol = Array.isArray(style && style.layers)
        ? style.layers.find((l) => l.type === 'symbol')
        : null;
      const beforeId = firstSymbol ? firstSymbol.id : undefined;
      // Insertion order = stacking order: alternatives sit beneath the
      // casing, and the selected route on top of both.
      map.addLayer(routeLayer('hm-routes-alt', { 'line-color': ROUTE_ALTERNATIVE_COLOR, 'line-width': 4, 'line-opacity': 0.7 }), beforeId);
      map.addLayer(routeLayer('hm-routes-casing', { 'line-color': ROUTE_CASING_COLOR, 'line-width': 9, 'line-opacity': 0.4 }), beforeId);
      map.addLayer(routeLayer('hm-routes-main', { 'line-color': ROUTE_COLOR, 'line-width': 6 }), beforeId);
      routeLayersReady = true;
      return true;
    } catch (err) {
      console.warn('[map] route layers failed: ' + (err && err.message));
      return false;
    }
  }

  function routeLayer(id, paint) {
    return {
      id,
      type: 'line',
      source: 'hm-routes',
      filter: ['==', ['get', 'selected'], id === 'hm-routes-main' || id === 'hm-routes-casing'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint,
    };
  }

  function routesFeatureCollection(routeList) {
    return {
      type: 'FeatureCollection',
      features: routeList.map((route) => ({
        type: 'Feature',
        properties: { selected: Boolean(route.selected) },
        geometry: {
          type: 'LineString',
          coordinates: route.coordinates,
        },
      })),
    };
  }

  // ── report pin rendering (Phase 6) ─────────────────────────────────────
  //
  // One GeoJSON source carries every report as a point; a single symbol
  // layer draws them as glyph pins. Each report type gets its own sprite
  // image (`report-pin-<type>`), rasterized once per pixel ratio from the
  // same glyphs the report form uses. Like routes, pins are inserted
  // before the style's first symbol layer and are held until the style is
  // ready. Rendering is serialized so a styledata storm cannot add the
  // layer twice.

  let reportJob = Promise.resolve();

  function applyReports(list) {
    reportJob = reportJob
      .then(async () => {
        if (!map || destroyed || !map.isStyleLoaded()) return;
        await ensureReportLayers();
        if (!map || destroyed || !reportLayersReady) return;
        try {
          map.getSource('hm-reports').setData(reportsFeatureCollection(list));
        } catch (err) {
          console.warn('[map] report render failed: ' + (err && err.message));
        }
      })
      .catch(() => {});
    return reportJob;
  }

  function clearReportSource() {
    try {
      map
        .getSource('hm-reports')
        .setData({ type: 'FeatureCollection', features: [] });
    } catch {
      /* the source is already gone (style swapped) */
    }
  }

  async function ensureReportLayers() {
    if (!map || reportLayersReady || !map.isStyleLoaded()) return;
    if (!map.getSource('hm-reports')) {
      map.addSource('hm-reports', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    const images = await reportImages();
    if (!map || destroyed) return;
    const style = map.getStyle();
    const firstSymbol = Array.isArray(style && style.layers)
      ? style.layers.find((l) => l.type === 'symbol')
      : null;
    const beforeId = firstSymbol ? firstSymbol.id : undefined;
    // Re-add the images even when the map style was swapped underneath us:
    // a swap drops sprites along with sources, and addImage throws on an
    // image the style still holds.
    for (const [id, canvas] of Object.entries(images)) {
      if (!map.hasImage(id)) {
        map.addImage(id, canvas, { pixelRatio: window.devicePixelRatio || 1 });
      }
    }
    map.addLayer(
      {
        id: 'hm-reports-pins',
        type: 'symbol',
        source: 'hm-reports',
        layout: {
          'symbol-placement': 'point',
          'icon-image': ['get', 'image'],
          'icon-size': 1,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      beforeId,
    );
    reportLayersReady = true;
  }

  function reportsFeatureCollection(list) {
    return {
      type: 'FeatureCollection',
      features: list
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
        .map((report) => ({
          type: 'Feature',
          properties: {
            id: String(report.id),
            type: report.type || 'other',
            effectiveStatus: report.effectiveStatus || report.status || 'pending',
            image: reportImageId(report),
          },
          geometry: { type: 'Point', coordinates: [report.lng, report.lat] },
        })),
    };
  }

  return {
    capabilities,

    async mount(container, options) {
      try {
        await mount(container, options);
      } catch (err) {
        throw toMapError(err, 'The map could not start.');
      }
    },

    centerOn(latlng, zoom) {
      if (!map) return;
      map.easeTo({
        center: [latlng.lng, latlng.lat],
        ...(typeof zoom === 'number' ? { zoom } : {}),
        duration: prefersReducedMotion() ? 0 : 600,
      });
    },

    zoomIn() {
      if (map) map.zoomIn({ duration: 200 });
    },

    zoomOut() {
      if (map) map.zoomOut({ duration: 200 });
    },

    resetNorth() {
      if (map) map.easeTo({ bearing: 0, duration: prefersReducedMotion() ? 0 : 300 });
    },

    setBearing(bearing) {
      if (map) map.setBearing(bearing);
    },

    setStyle(nextStyleUrl) {
      if (map && nextStyleUrl) map.setStyle(nextStyleUrl);
    },

    // `location` is { lat, lng, accuracy } or null to clear. The accuracy
    // circle is drawn only when the device reports a usable accuracy value.
    setUserLocation(location) {
      if (!map) return;
      if (!location) {
        if (marker) {
          marker.remove();
          marker = null;
        }
        if (accuracySource) {
          map.getSource('user-accuracy').setData({ type: 'FeatureCollection', features: [] });
        }
        return;
      }
      const lngLat = [location.lng, location.lat];
      if (!marker) {
        marker = new maplibregl.Marker({ color: MARKER_COLOR }).setLngLat(lngLat).addTo(map);
      } else {
        marker.setLngLat(lngLat);
      }
      if (accuracySource && typeof location.accuracy === 'number' && location.accuracy > 0) {
        map
          .getSource('user-accuracy')
          .setData(circleFeature(location.lng, location.lat, location.accuracy));
      } else if (accuracySource) {
        map.getSource('user-accuracy').setData({ type: 'FeatureCollection', features: [] });
      }
    },

    // `routes` is an array of { coordinates: [[lng, lat], ...], selected }
    // or null to clear. Each becomes a GeoJSON line feature; the selected
    // route draws on top (brand colour, cased) and alternatives sit beneath
    // it, muted. Data set before the style is ready is held and applied on
    // load, so a screen never has to wait for the map first.
    setRoutes(nextRoutes) {
      routes = Array.isArray(nextRoutes) && nextRoutes.length ? nextRoutes : null;
      if (routes && map && map.isStyleLoaded()) applyRoutes(routes);
      else if (!routes && map && map.isStyleLoaded() && routeLayersReady) {
        clearRouteSource();
      }
    },

    // `reports` is an array of { id, type, lat, lng, effectiveStatus } or
    // null to clear. Each becomes a glyph pin; expired reports render grey.
    // Data set before the style is ready is held and applied on load, the
    // same way routes are.
    setReports(nextReports) {
      reports = Array.isArray(nextReports) && nextReports.length ? nextReports : null;
      if (reports && map && map.isStyleLoaded()) applyReports(reports);
      else if (!reports && map && map.isStyleLoaded() && reportLayersReady) {
        clearReportSource();
      }
    },

    fitBounds(bounds, opts = {}) {
      if (!map || !bounds) return;
      const sw = [bounds.west, bounds.south];
      const ne = [bounds.east, bounds.north];
      if (![...sw, ...ne].every(Number.isFinite)) return;
      map.fitBounds([sw, ne], {
        padding: opts.padding || 48,
        maxZoom: opts.maxZoom || 16,
        duration: prefersReducedMotion() ? 0 : 800,
      });
    },

    destroy() {
      destroyed = true;
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (marker) {
        marker.remove();
        marker = null;
      }
      if (map) {
        try {
          map.remove();
        } catch {
          /* the container may already be gone */
        }
        map = null;
      }
    },
  };
}

const NETWORK_MESSAGE =
  'We could not reach the map. Check your connection and try again.';

// A geodesic circle of `radius` metres around a point, as a GeoJSON polygon.
function circleFeature(lng, lat, radius) {
  const points = 64;
  const coords = [];
  const earth = 6378137;
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * (Math.PI * 2);
    const dx = radius * Math.cos(angle);
    const dy = radius * Math.sin(angle);
    const dLng = (dx / earth) * (180 / Math.PI) / Math.cos((lat * Math.PI) / 180);
    const dLat = (dy / earth) * (180 / Math.PI);
    coords.push([lng + dLng, lat + dLat]);
  }
  coords.push(coords[0]);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [coords] },
      },
    ],
  };
}

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// The sprite id a report renders with: its type glyph, in the grey variant
// once the report's window has ended.
function reportImageId(report) {
  const type = report.type || 'other';
  const expired = (report.effectiveStatus || report.status) === 'expired';
  return expired ? `${type}-expired` : type;
}
