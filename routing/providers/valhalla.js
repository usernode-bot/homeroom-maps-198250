// Valhalla adapter — PLACEHOLDER, not configured.
//
// No Valhalla deployment exists for this app yet (see
// docs/routing-provider-comparison.md for the full evaluation: the strongest
// open engine for pedestrian/cycling profiles and elevation, but there is no
// free hosted instance and self-hosting needs its own tile build and RAM).
// The adapter is an honest stub: isConfigured() is false and every call
// throws not_configured rather than returning anything, so no screen can
// mistake it for a working integration. It is filled in — with its endpoint
// URL via config.js — in the same change that implements it.
//
// TODO(implement): endpoint mapping from the provider evaluation.
//   route   -> POST https://<host>/route
//              body: { locations: [{lat, lon}, ...], costing: 'auto'|'bicycle'|
//              'pedestrian'|'motorcycle'|'transit', alternates: 2,
//              directions_type: 'instructions' }
//   modes   -> auto, bicycle, pedestrian, motorcycle, transit (bus/ferry)
//   extras  -> restrictions, elevation, live traffic on costing options
// Attribution: OpenStreetMap (ODbL) + Valhalla; wire the attribution line
// when this adapter ships.
'use strict';

const { routingError } = require('../provider');

const MESSAGE =
  'Valhalla routing is not connected yet. Point VALHALLA_URL at a Valhalla instance to enable it.';

function createValhalla() {
  return {
    name: 'valhalla',
    label: 'Valhalla',
    attribution: 'OpenStreetMap',
    public: false,
    capabilities: {
      modes: [],
      alternatives: true,
      waypoints: true,
      steps: true,
      traffic: true,
      restrictions: true,
      transit: true,
    },
    isConfigured() {
      return false;
    },
    route() {
      throw routingError('not_configured', MESSAGE);
    },
  };
}

module.exports = { createValhalla };
