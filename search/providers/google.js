// Google Places adapter — PLACEHOLDER, not configured.
//
// No Google Places key exists in this app yet (see docs/provider-comparison.md:
// autocomplete $2.83/1k after 10k/mo free, sessions priced separately, Place
// Details $5-25/1k; the strongest multilingual and typo correction of the six
// evaluated). Honest stub: isConfigured() is false, every call throws
// not_configured, nothing is invented. Implemented together with a
// GOOGLE_PLACES_API_KEY secret (private: true plus a staging_default) in the
// change that fills it in.
//
// TODO(implement): endpoint mapping from the provider evaluation.
//   suggest -> POST https://places.googleapis.com/v1/places:autocomplete
//              with a session token; sessions end with a Place Details call
//              (Essentials SKU) to get the session pricing benefit
//   search  -> POST https://places.googleapis.com/v1/places:searchText
//   bbox    -> X-Goog-FieldMask plus `locationRestriction: rectangle`
//   near    -> `locationBias: circle { center, radius }`
//   lang    -> `languageCode=` (BCP-47)
//   key     -> `GOOGLE_PLACES_API_KEY` request header
// Attribution: Google requires "Powered by Google" attribution; wire the
// attribution line's provider check when this adapter ships.
'use strict';

const { searchError } = require('../provider');

function createGoogle() {
  return {
    name: 'google',
    public: false,
    supportsSuggest: true, // once implemented
    isConfigured() {
      return false;
    },
    suggest() {
      throw searchError(
        'not_configured',
        'Google Places search is not connected yet. A GOOGLE_PLACES_API_KEY secret must be set in the Secrets UI.',
      );
    },
    search() {
      throw searchError(
        'not_configured',
        'Google Places search is not connected yet. A GOOGLE_PLACES_API_KEY secret must be set in the Secrets UI.',
      );
    },
  };
}

module.exports = { createGoogle };