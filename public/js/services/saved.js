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
// Phase 7 wired the server-backed adapter in (services/saved-places.js):
// serverAdapter implements this contract over /api/saved and is passed to
// createSavedPlacesService() there. The placeholder below is unchanged and
// still returned when no adapter is supplied, so a screen that forgets to
// wire one refuses honestly instead of inventing saved data.
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