// Place Detail session — the pure state machine behind the Place Detail view.
//
// A detail opens from a summary place (usually a mapped search result, see
// places-model.js) and then enriches: it asks the server's PlaceService for
// the full place (photos, hours, contact, rating — whatever the configured
// provider carries). The session owns exactly that lifecycle so the view is a
// pure function of the snapshot:
//
//   loading      — the enrichment fetch is in flight
//   ready        — enrichment answered (or answered null); render everything
//                  the merged place carries, "Not available" elsewhere
//   unavailable  — the server answered not_configured: no place provider is
//                  connected. Not a failure — the app's honest state this
//                  phase ships in. Summary data still renders.
//   error        — the enrichment failed (provider error, network). The
//                  summary still renders and retry() re-runs the fetch.
//
// The never-crash rule lives here: no fetch outcome throws, stale responses
// (an older fetch answering after a newer retry) are dropped, and the
// initial summary is never mutated in place.
'use strict';

import { mergePlace } from './places-model.js';

export function createPlaceDetailSession({ place, fetchDetails } = {}) {
  if (!place || typeof place !== 'object' || !place.id) {
    throw new Error('createPlaceDetailSession needs a place with an id.');
  }
  if (typeof fetchDetails !== 'function') {
    throw new Error('createPlaceDetailSession needs a fetchDetails(placeId) function.');
  }

  let state = {
    place: { ...place },
    phase: 'loading', // loading | ready | unavailable | error
    error: null, // the enrichment failure, in the error phase
  };

  const listeners = new Set();
  let generation = 0;

  function snapshot() {
    return { ...state };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function load() {
    generation += 1;
    const gen = generation;
    state = { place: state.place, phase: 'loading', error: null };
    emit();
    try {
      const details = await fetchDetails(place.id);
      if (gen !== generation) return; // a newer retry won
      state = {
        place: details ? mergePlace(state.place, details) : state.place,
        phase: 'ready',
        error: null,
      };
    } catch (err) {
      if (gen !== generation) return;
      const code = err && err.code;
      state = {
        place: state.place,
        phase: code === 'not_configured' ? 'unavailable' : 'error',
        error: err && code !== 'not_configured' ? err : null,
      };
    }
    emit();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: snapshot,
    start: load,
    retry: load,
  };
}