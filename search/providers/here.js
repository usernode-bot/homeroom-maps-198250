// HERE adapter — PLACEHOLDER, not configured.
//
// No HERE key exists in this app yet (see docs/provider-comparison.md:
// freemium 250k free transactions/mo, 250 tracked "assets"; /autocomplete
// suggestions each count as transactions, and the follow-up /lookup or
// /geocode per selection is another). Honest stub: isConfigured() is false,
// every call throws not_configured, nothing is invented. Implemented together
// with a HERE_API_KEY secret (private: true plus a staging_default) in the
// change that fills it in.
//
// TODO(implement): endpoint mapping from the provider evaluation.
//   suggest -> GET https://autocomplete.search.hereapi.com/v1/autocomplete
//              (returns completions with `highlights`; the selecting call
//              needs a follow-up /lookup by id for coordinates)
//   search  -> GET https://discover.search.hereapi.com/v1/discover
//   bbox    -> `in=bbox:minLon,minLat,maxLon,maxLat`
//   near    -> `at=lat,lon` (bias; circle forms exist on Discover)
//   lang    -> `lang=` (BCP-47)
//   key     -> `apiKey=` (HERE_API_KEY)
// Attribution: HERE requires its own legal notice; wire the attribution
// line's provider check when this adapter ships.
'use strict';

const { searchError } = require('../provider');

function createHere() {
  return {
    name: 'here',
    public: false,
    supportsSuggest: true, // once implemented
    isConfigured() {
      return false;
    },
    suggest() {
      throw searchError(
        'not_configured',
        'HERE search is not connected yet. A HERE_API_KEY secret must be set in the Secrets UI.',
      );
    },
    search() {
      throw searchError(
        'not_configured',
        'HERE search is not connected yet. A HERE_API_KEY secret must be set in the Secrets UI.',
      );
    },
  };
}

module.exports = { createHere };