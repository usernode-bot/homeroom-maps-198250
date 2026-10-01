// Places service — the client-side half of the PlaceService (server places/).
// The server normalizes every place into the provider-independent model
// (places/place.js) before it leaves, so this module only binds the
// authenticated fetchers and guards the response shapes. Typed ApiErrors from
// apiGet() carry the server's codes unchanged: not_configured (no place
// provider yet), invalid_query, not_found, provider_error.
import { apiGet } from '../api.js';

// Search/browse places by a term and/or location. Summaries only — per-place
// depth comes from fetchPlace(). Returns [] when the answer carries no list;
// it never fabricates a row.
export async function fetchPlaces(
  q,
  { signal, near, radiusKm, bbox, limit } = {},
) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (near) params.set('near', `${Number(near.lat)},${Number(near.lon)}`);
  if (radiusKm) params.set('radius', String(Number(radiusKm)));
  if (bbox) params.set('bbox', bbox.map(Number).join(','));
  if (limit) params.set('limit', String(Number(limit)));
  const body = await apiGet(`/api/places?${params.toString()}`, { signal });
  return Array.isArray(body && body.results) ? body.results : [];
}

// One place at full depth (photos, hours, contact, rating — whatever the
// configured provider carries). Returns the place object, or null when the
// server answers without one.
export async function fetchPlace(id, { signal } = {}) {
  const body = await apiGet(`/api/places/${encodeURIComponent(id)}`, { signal });
  return (body && body.place) || null;
}