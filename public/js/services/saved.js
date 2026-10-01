// SavedPlacesAdapter — the interface for saving, unsaving and checking places.
//
// The contract an adapter must implement (all async):
//
//   {
//     save(place),      // -> the stored saved place
//     unsave(id),       // -> when the place is no longer saved
//     isSaved(id),      // -> boolean for THIS device/user, real data only
//     list(),           // -> array of saved places
//   }
//
// PLACEHOLDER(adapter-phase): no adapter exists yet, so createSavedPlacesService()
// without one returns the honest placeholder: every call throws
// SavedPlacesUnavailableError (code not_configured). Deliberately no fake
// saved data — a saved-places list the app invents would fabricate user
// intent. The server route /api/saved answers 501 for the same reason.
//
// TODO(saved-phase): implement an adapter backed by a server table (the
// platform's auth gate already covers /api/saved) or device-local storage,
// and hand it to createSavedPlacesService(). Nothing else changes.
'use strict';

export class SavedPlacesUnavailableError extends Error {
  constructor(message = 'Saved places are not built yet.') {
    super(message);
    this.name = 'SavedPlacesUnavailableError';
    this.code = 'not_configured';
  }
}

// Wire an adapter in. Validates the contract up front so a half-implemented
// adapter fails loudly at the wiring site, not on first user action.
export function createSavedPlacesService(adapter) {
  if (adapter == null) {
    return {
      save: async () => {
        throw new SavedPlacesUnavailableError();
      },
      unsave: async () => {
        throw new SavedPlacesUnavailableError();
      },
      isSaved: async () => {
        throw new SavedPlacesUnavailableError();
      },
      list: async () => {
        throw new SavedPlacesUnavailableError();
      },
    };
  }
  for (const method of ['save', 'unsave', 'isSaved', 'list']) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`A SavedPlacesAdapter must implement ${method}().`);
    }
  }
  return adapter;
}