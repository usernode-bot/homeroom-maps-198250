// Mapbox adapter — PLACEHOLDER, not configured.
//
// No Mapbox key exists in this app yet (see docs/provider-comparison.md for
// the full evaluation: Search Box sessions, temporary geocoding 100k free/mo
// then ~$0.75/1k). The adapter is an honest stub: isConfigured() is false and
// every call throws not_configured rather than returning anything, so no
// screen can mistake it for a working integration. It is filled in — together
// with a MAPBOX_ACCESS_TOKEN secret declared in dapp.json (private: true plus
// a staging_default) — in the same change that implements it.
//
// TODO(implement): endpoint mapping from the provider evaluation.
//   suggest -> GET https://api.mapbox.com/geocoding/v5/mapbox.places/{q}.json
//              (or Search Box /suggest with a session_token: /suggest +
//              /retrieve are billed per session, up to 50 suggest calls each)
//   search  -> Search Box /forward (billed per request), or temporary
//              geocoding for one-off lookups
//   bbox    -> `bbox=minLon,minLat,maxLon,maxLat`
//   near    -> `proximity=lon,lat`
//   lang    -> `language=` (comma-separated codes)
//   key     -> `access_token=` (MAPBOX_ACCESS_TOKEN)
// Attribution: Mapbox requires its own attribution line in the UI; wire the
// attribution line's provider check when this adapter ships.
'use strict';

const { searchError } = require('../provider');

function createMapbox() {
  return {
    name: 'mapbox',
    public: false,
    supportsSuggest: true, // once implemented
    isConfigured() {
      return false;
    },
    suggest() {
      throw searchError(
        'not_configured',
        'Mapbox search is not connected yet. A MAPBOX_ACCESS_TOKEN secret must be set in the Secrets UI.',
      );
    },
    search() {
      throw searchError(
        'not_configured',
        'Mapbox search is not connected yet. A MAPBOX_ACCESS_TOKEN secret must be set in the Secrets UI.',
      );
    },
  };
}

module.exports = { createMapbox };