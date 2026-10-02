// Trips service — the Trips screen's browser-facing half over this app's own
// JSON API. It binds the authenticated apiGet/apiSend wrappers to the
// /api/trips routes; the screen never talks to a provider or to Postgres.
//
// Every call resolves with the server's shape or throws the typed ApiError,
// so a validation failure (error.fields) or a not-found can be rendered
// honestly. It deliberately does NOT import or wrap services/saved.js: the
// "Saved places" source in the add-place sheet is static unavailable copy,
// not a saved-place request.
import { apiGet, apiSend } from '../api.js';

export async function fetchTrips({ demo = false } = {}) {
  const body = await apiGet('/api/trips' + (demo ? '?demo=1' : ''));
  return {
    items: Array.isArray(body && body.items) ? body.items : [],
    demo: Boolean(body && body.demo),
  };
}

export async function fetchTrip(id) {
  return apiGet('/api/trips/' + encodeURIComponent(id));
}

export async function createTrip(input) {
  return apiSend('POST', '/api/trips', input);
}

export async function updateTrip(id, input) {
  return apiSend('PATCH', '/api/trips/' + encodeURIComponent(id), input);
}

export async function deleteTrip(id) {
  return apiSend('DELETE', '/api/trips/' + encodeURIComponent(id));
}

export async function addItem(tripId, dayId, input) {
  return apiSend(
    'POST',
    '/api/trips/' + encodeURIComponent(tripId) + '/days/' + encodeURIComponent(dayId) + '/items',
    input,
  );
}

export async function updateItem(tripId, itemId, input) {
  return apiSend(
    'PATCH',
    '/api/trips/' + encodeURIComponent(tripId) + '/items/' + encodeURIComponent(itemId),
    input,
  );
}

export async function removeItem(tripId, itemId) {
  return apiSend(
    'DELETE',
    '/api/trips/' + encodeURIComponent(tripId) + '/items/' + encodeURIComponent(itemId),
  );
}

// Move an item to `dayId` at `index`. Passing the item's own day reorders it
// in place. The server clamps an out-of-range index into the target day.
export async function moveItem(tripId, itemId, { dayId, index }) {
  return apiSend(
    'POST',
    '/api/trips/' + encodeURIComponent(tripId) + '/items/' + encodeURIComponent(itemId) + '/move',
    { dayId, index },
  );
}
