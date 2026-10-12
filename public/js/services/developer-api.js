// Developer API service (Phase 12K) — the screen's thin client for the
// /api/v1 key-management surface. That surface is JWT-gated like every
// internal route (the API keys themselves are a different credential and can
// never reach it), so these calls ride the app's own auth exactly like the
// rest of the app's API clients. No caching: the key list is short and the
// screen reloads it after every change.
import { apiGet, apiSend } from '../api.js';

// The person's keys plus the service facts the screen displays (the rate
// limit and the directions token cost come from the same response).
export function fetchDeveloperApi() {
  return apiGet('/api/v1/keys');
}

// Create a key. The full plaintext is in THIS response only, never again:
// the server stores a hash, so the screen must offer copying before the
// dialog closes.
export function createApiKey(name) {
  return apiSend('POST', '/api/v1/keys', { name });
}

export function revokeApiKey(id) {
  return apiSend('DELETE', `/api/v1/keys/${encodeURIComponent(id)}`);
}
