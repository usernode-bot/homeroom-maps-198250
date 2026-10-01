// Fetch wrapper for this app's own JSON API. Every request carries the
// platform token, a non-2xx or network failure becomes a typed ApiError, and
// pending requests are announced so the shell can show a loading state.
import { authHeaders } from './auth.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', fields = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // Per-field validation messages, when the server sent them.
    this.fields = fields;
  }
}

const pendingListeners = new Set();
let pendingCount = 0;

export function onPendingChange(fn) {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}

function setPending(delta) {
  pendingCount = Math.max(0, pendingCount + delta);
  for (const fn of pendingListeners) {
    try {
      fn(pendingCount > 0);
    } catch (err) {
      console.error(err);
    }
  }
}

export function apiGet(path, { signal } = {}) {
  return request('GET', path, undefined, { signal });
}

// Writes (POST/PUT/PATCH/DELETE) with an optional JSON body. Same error
// contract as apiGet.
export function apiSend(method, path, body) {
  return request(method, path, body, {});
}

async function request(method, path, body, { signal } = {}) {
  setPending(1);
  try {
    const headers = { Accept: 'application/json', ...authHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const error = (payload && payload.error) || {};
      const message =
        error.message || `The server could not answer that request (${res.status}).`;
      throw new ApiError(message, {
        status: res.status,
        code: error.code || 'http_error',
        fields: error.fields || null,
      });
    }
    return payload;
  } catch (err) {
    // An aborted request is the caller's own doing (superseded by a newer
    // query), not a failure: rethrow it unchanged so the caller can ignore
    // it instead of surfacing a network error.
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw err;
    if (err instanceof ApiError) throw err;
    throw new ApiError('We could not reach the server.', {
      code: 'network_error',
    });
  } finally {
    setPending(-1);
  }
}

export function fetchConfig() {
  return apiGet('/api/config');
}

export function fetchMe() {
  return apiGet('/api/me');
}
