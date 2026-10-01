// GraphHopper adapter — PLACEHOLDER, not configured.
//
// No GraphHopper key exists in this app yet (see
// docs/routing-provider-comparison.md for the full evaluation: strong global
// coverage, car/foot/bike, a hosted API whose free tier needs an account and
// key, and a self-host path). The adapter is an honest stub: isConfigured()
// is false and every call throws not_configured rather than returning
// anything, so no screen can mistake it for a working integration. It is
// filled in — together with a GRAPHHOPPER_API_KEY secret declared in
// dapp.json (private: true plus a staging_default) — in the same change that
// implements it.
//
// TODO(implement): endpoint mapping from the provider evaluation.
//   route   -> GET https://graphhopper.com/api/1/route?point=lat,lon&...
//              one point per leg boundary + point_hint; `key=` required
//   modes   -> car, foot, bike, truck, motorcycle? (profile-dependent)
//   extras  -> alternatives (n), instructions, turn_restrictions on some plans
// Attribution: OpenStreetMap (ODbL) + GraphHopper; wire the attribution line
// when this adapter ships.
'use strict';

const { routingError } = require('../provider');

const MESSAGE =
  'GraphHopper routing is not connected yet. Set the GRAPHHOPPER_API_KEY secret to enable it.';

function createGraphhopper() {
  return {
    name: 'graphhopper',
    label: 'GraphHopper',
    attribution: 'OpenStreetMap',
    public: false,
    capabilities: {
      modes: [],
      alternatives: true,
      waypoints: true,
      steps: true,
      traffic: false,
      restrictions: true,
      transit: false,
    },
    isConfigured() {
      return false;
    },
    route() {
      throw routingError('not_configured', MESSAGE);
    },
  };
}

module.exports = { createGraphhopper };
