// Saved places service — the browser half of the saved API (/api/saved).
//
// Lists, their places, suggestions and comments are real: every call goes to
// the server and every number on screen is what the server returned. Nothing
// here invents a place, a count or a comment — an empty answer renders the
// empty state, a failure renders the error state.
//
// The old flat SavedPlacesAdapter contract (save/unsave/isSaved/list) is
// gone: saving happens through lists now, and the server is the only place
// visibility is decided. The adapter placeholder this module once carried
// was the honest "not built yet" seam; this rewrite replaces it.
//
// Shape notes:
//   list card   { id, name, emoji, visibility, owner: { id, username },
//                 itemCount, createdAt, updatedAt,
//                 viewer: { isOwner, canWrite },
//                 pendingSuggestions?,   // owner only
//                 shareToken? }          // owner only, visibility 'link'
//   list detail { list: <card>, items: [item], suggestions: [suggestion],
//                 viewer: { isOwner, canWrite } }
//   item        { id, listId, place: { name, address, kind, provider, lat, lng },
//                 note, source, addedBy: { id, username },
//                 createdAt, commentCount }
//   suggestion  { id, listId, from: { id, username }, message, place,
//                 status, createdAt, decidedAt }
//   comment     { id, itemId, author: { id, username }, body, createdAt }
//
// PLACE SNAPSHOT. A saved place is the search result as it was at save
// time — name, address, kind, provider, coordinates — never re-fetched and
// never enriched, because no place provider is connected and none may be
// invented. placeToSnapshot() maps the Place model a search produces into
// that snapshot for the POST bodies.
//
// EMOJI MARKER CONTRACT (for the map phase). The list's `emoji` is the
// marker for all of its places. While /api/config reports mapProvider: null
// the emoji renders as the list badge and each item row's leading glyph;
// when a map canvas ships, the marker adapter reads list.emoji per item —
// no redesign, just a renderer.
import { apiGet, apiSend } from '../api.js';

export async function fetchMyLists({ signal } = {}) {
  const body = await apiGet('/api/saved/lists?view=mine', { signal });
  return Array.isArray(body && body.items) ? body.items : [];
}

export async function fetchPublicLists({ offset, limit, signal } = {}) {
  const params = new URLSearchParams({ view: 'public' });
  if (offset) params.set('offset', String(offset));
  if (limit) params.set('limit', String(limit));
  const body = await apiGet(`/api/saved/lists?${params.toString()}`, { signal });
  return {
    items: Array.isArray(body && body.items) ? body.items : [],
    hasMore: Boolean(body && body.hasMore),
    nextOffset: (body && body.nextOffset) || null,
  };
}

// The Shared level's key rides along on reads; writes never accept it.
function keyQuery(key) {
  return key ? `?key=${encodeURIComponent(key)}` : '';
}

export async function fetchList(id, { key = null, signal } = {}) {
  const body = await apiGet(`/api/saved/lists/${encodeURIComponent(id)}${keyQuery(key)}`, { signal });
  return {
    list: (body && body.list) || null,
    items: Array.isArray(body && body.items) ? body.items : [],
    suggestions: Array.isArray(body && body.suggestions) ? body.suggestions : [],
    viewer: (body && body.viewer) || { isOwner: false, canWrite: false },
  };
}

export function createList(input) {
  return apiSend('POST', '/api/saved/lists', input);
}

export function updateList(id, patch) {
  return apiSend('PATCH', `/api/saved/lists/${encodeURIComponent(id)}`, patch);
}

export function deleteList(id) {
  return apiSend('DELETE', `/api/saved/lists/${encodeURIComponent(id)}`);
}

export function addPlace(listId, place, { note = null } = {}) {
  return apiSend('POST', `/api/saved/lists/${encodeURIComponent(listId)}/items`, { place, note });
}

export function updateNote(listId, itemId, note) {
  return apiSend('PATCH', `/api/saved/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, { note });
}

export function removePlace(listId, itemId) {
  return apiSend('DELETE', `/api/saved/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`);
}

export function suggestPlace(listId, place, message = null) {
  return apiSend('POST', `/api/saved/lists/${encodeURIComponent(listId)}/suggestions`, { place, message });
}

export function acceptSuggestion(id) {
  return apiSend('POST', `/api/saved/suggestions/${encodeURIComponent(id)}/accept`);
}

export function rejectSuggestion(id) {
  return apiSend('POST', `/api/saved/suggestions/${encodeURIComponent(id)}/reject`);
}

export async function fetchComments(itemId, { key = null, signal } = {}) {
  const body = await apiGet(`/api/saved/items/${encodeURIComponent(itemId)}/comments${keyQuery(key)}`, { signal });
  return Array.isArray(body && body.items) ? body.items : [];
}

export function addComment(itemId, body, { key = null } = {}) {
  return apiSend('POST', `/api/saved/items/${encodeURIComponent(itemId)}/comments${keyQuery(key)}`, { body });
}

export function deleteComment(commentId) {
  return apiSend('DELETE', `/api/saved/comments/${encodeURIComponent(commentId)}`);
}

// Place model (places-model.js placeFromSearchResult) -> the snapshot the
// server stores. Coordinates are required by the server; a search result
// without any is not saveable, and callers check hasCoords() first.
export function placeToSnapshot(place) {
  if (!place || typeof place !== 'object') return null;
  const coordinates = place.coordinates || {};
  return {
    name: place.name,
    lat: coordinates.lat,
    lng: coordinates.lon,
    address: place.address || null,
    kind: place.subcategory || place.category || null,
    provider: place.dataSource && place.dataSource !== 'unknown' ? place.dataSource : null,
    id: typeof place.id === 'string' ? place.id : null,
  };
}

export function hasCoords(place) {
  if (!place || !place.coordinates) return false;
  return Number.isFinite(place.coordinates.lat) && Number.isFinite(place.coordinates.lon);
}