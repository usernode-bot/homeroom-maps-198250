// Fetch wrapper for this app's own JSON API. Every request carries the
// platform token, a non-2xx or network failure becomes a typed ApiError, and
// pending requests are announced so the shell can show a loading state.
import { authHeaders } from './auth.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

export async function apiGet(path, { signal } = {}) {
  setPending(1);
  try {
    const res = await fetch(path, {
      headers: { Accept: 'application/json', ...authHeaders() },
      signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message =
        (body && body.error && body.error.message) ||
        `The server could not answer that request (${res.status}).`;
      const code = (body && body.error && body.error.code) || 'http_error';
      throw new ApiError(message, { status: res.status, code });
    }
    return body;
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
