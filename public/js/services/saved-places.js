// Saved places service (Phase 7) — the browser half of /api/saved.
//
// Two layers live here, deliberately:
//
//   1. `serverAdapter` implements the SavedPlacesAdapter contract the repo
//      already documented (services/saved.js): save / unsave / isSaved / list.
//      Wiring it through createSavedPlacesService() is the TODO that module
//      left for this phase, so the contract and its test are unchanged.
//   2. The list operations (default and custom lists) the Saved screen and the
//      Profile integration need.
//
// A saved place references a REAL place id — the id the search stack already
// gives every result (services/places-model.js). Nothing here invents a place
// and nothing fabricates a saved list: every function returns exactly what the
// server answered.
import { apiGet, apiSend } from '../api.js';
import { createSavedPlacesService } from './saved.js';

// The four default list slugs, mirroring saved/model.js. The client uses them
// for the picker's ordering and for the honest "these always exist" copy;
// the server is still the authority that seeds them.
export const DEFAULT_LIST_SLUGS = ['favorites', 'want_to_visit', 'travel', 'restaurants'];

// Map one place (the app's Place model, services/places-model.js) onto the
// reference the API stores. Only real values are sent; absent ones stay null.
export function placeRef(place) {
  if (!place || typeof place !== 'object' || !place.id) return null;
  const coords = place.coordinates || {};
  const lat = Number(coords.lat);
  const lon = Number(coords.lon);
  return {
    id: String(place.id),
    name: typeof place.name === 'string' && place.name ? place.name : null,
    address: typeof place.address === 'string' && place.address ? place.address : null,
    category: typeof place.category === 'string' && place.category ? place.category : null,
    subcategory: typeof place.subcategory === 'string' && place.subcategory ? place.subcategory : null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lon) ? lon : null,
    source: typeof place.dataSource === 'string' && place.dataSource ? place.dataSource : null,
  };
}

// A stored saved place -> the app's Place model, so the ONE reusable Place
// Card renders it with the same gating logic as every other surface. Every
// optional field is present and null when the saved data does not carry it —
// nothing is invented to fill a card.
export function savedToPlace(saved) {
  if (!saved || typeof saved !== 'object' || !saved.id) return null;
  const lat = Number(saved.lat);
  const lng = Number(saved.lng);
  return {
    id: String(saved.id),
    name: saved.name || '',
    localizedNames: null,
    category: saved.category || null,
    subcategory: saved.subcategory || null,
    coordinates: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lon: lng } : null,
    address: saved.address || null,
    country: null,
    phone: null,
    website: null,
    openingHours: null,
    rating: null,
    photos: [],
    businessStatus: null,
    verificationStatus: null,
    dataSource: saved.source || 'unknown',
  };
}

// ---- the SavedPlacesAdapter contract, bound to the server ----

export const serverAdapter = {
  // Save a place. `list` is optional; the screen's one-tap save files a new
  // place into Favorites, which is a real default list, not a guess.
  async save(place, { list = 'favorites' } = {}) {
    const ref = placeRef(place);
    if (!ref) throw new Error('save() needs a place with an id.');
    return apiSend('POST', '/api/saved/places', { place: ref, list });
  },
  async unsave(id) {
    return apiSend('DELETE', `/api/saved/places/${encodeURIComponent(id)}`);
  },
  async isSaved(id) {
    const body = await apiGet(`/api/saved/places/${encodeURIComponent(id)}/status`);
    return Boolean(body && body.saved);
  },
  async list() {
    const body = await apiGet('/api/saved/places');
    return Array.isArray(body && body.places) ? body.places : [];
  },
};

// The app's wired saved-places service. The contract validation in
// services/saved.js runs here, at the wiring site.
export const savedPlaces = createSavedPlacesService(serverAdapter);

// ---- lists ----

export function fetchOverview() {
  return apiGet('/api/saved');
}

export async function fetchLists() {
  const body = await apiGet('/api/saved/lists');
  return Array.isArray(body && body.lists) ? body.lists : [];
}

export async function fetchList(id) {
  return apiGet(`/api/saved/lists/${encodeURIComponent(id)}`);
}

export async function fetchPlaces() {
  const body = await apiGet('/api/saved/places');
  return Array.isArray(body && body.places) ? body.places : [];
}

// Create a custom list. The server's per-field message reaches the caller as
// an ApiError with .fields, which the form shows.
export function createList(name, description) {
  return apiSend('POST', '/api/saved/lists', { name, description });
}

export function renameList(id, name) {
  return apiSend('PATCH', `/api/saved/lists/${encodeURIComponent(id)}`, { name });
}

export function deleteList(id) {
  return apiSend('DELETE', `/api/saved/lists/${encodeURIComponent(id)}`);
}

// `listRef` is a default slug or a numeric id. `place` may be a full Place
// (which is saved along the way) or `placeId` for one already saved.
export function addToList(listRef, place) {
  const ref = placeRef(place);
  const body = ref ? { place: ref } : { placeId: place && place.id };
  return apiSend('POST', `/api/saved/lists/${encodeURIComponent(listRef)}/items`, body);
}

export function removeFromList(listRef, placeId) {
  return apiSend('DELETE', `/api/saved/lists/${encodeURIComponent(listRef)}/items`, { placeId });
}

// Which of the person's lists a place is already in (real membership, read
// from the saved list itself). Returns a Set of list ids as strings.
export async function listsContaining(placeId) {
  const lists = await fetchLists();
  const memberships = await Promise.all(
    lists.map(async (list) => {
      try {
        const detail = await fetchList(list.id);
        return (detail.items || []).some((item) => item.id === placeId) ? String(list.id) : null;
      } catch {
        return null;
      }
    }),
  );
  return new Set(memberships.filter(Boolean));
}
