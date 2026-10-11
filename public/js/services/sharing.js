// Location sharing client bindings (Phase 12F) — thin wrappers over the seven
// real /api/sharing routes, plus the wiring that feeds the pure loop in
// sharing-core.js. No state machine lives here; no consent decision either:
// consentToSession() is only ever called from a person's own tap.
'use strict';

import { apiGet, apiSend } from '../api.js';
import { getCurrentLocation } from './location.js';
import {
  createSharingLoop,
  consentedTo as consentedToCore,
  consentToSession as consentToSessionCore,
} from './sharing-core.js';

// Re-exported so screens and tests import one module.
export {
  SHARING_LOOP,
  SHARING_INTERVAL_MS,
  STALE_AFTER_SECONDS,
  VERY_STALE_AFTER_SECONDS,
  ageLabel,
  expiresInLabel,
  consentText,
  deviceStatusText,
  isStale,
  isVeryStale,
} from './sharing-core.js';
export { consentedToCore as consentedTo, consentToSessionCore as consentToSession };

// ── API bindings ──────────────────────────────────────────────────────────
// One per real route; the names mirror the server's contract.

export function fetchSharingMembers() {
  return apiGet('/api/sharing/members');
}

export function fetchMySession() {
  return apiGet('/api/sharing/sessions/mine');
}

export function fetchIncoming() {
  return apiGet('/api/sharing/incoming');
}

export function startShare(recipients, durationMinutes) {
  return apiSend('POST', '/api/sharing/sessions', {
    recipients,
    durationMinutes,
  });
}

export function stopShare(sessionId) {
  return apiSend('DELETE', '/api/sharing/sessions/' + encodeURIComponent(String(sessionId)));
}

export function dismissIncoming(sessionId) {
  return apiSend(
    'POST',
    '/api/sharing/incoming/' + encodeURIComponent(String(sessionId)) + '/dismiss',
  );
}

// ── The device update loop ────────────────────────────────────────────────
// Kept at module scope so navigating away from the sharing screen (while the
// app stays open) does not silently stop updates: the loop pauses only when
// the whole frame is hidden, and stops for good on Stop, expiry, or the
// person's permission decision.

let loop = null;

// Start (or keep) the loop for this session. Returns the loop, or null when
// it was not started because the person has not consented in this page load.
export function ensureSharingLoop(session, { onState } = {}) {
  const id = session && session.id != null ? String(session.id) : null;
  if (!id || !consentedToCore(id)) return null;
  if (loop && loop.snapshot().sessionId === id) {
    if (onState) loop.setOnState(onState);
    return loop;
  }
  if (loop) loop.stop();
  loop = createSharingLoop({
    sessionId: id,
    getFix: () => getCurrentLocation(),
    postLocation: (fix) =>
      apiSend(
        'POST',
        '/api/sharing/sessions/' + encodeURIComponent(id) + '/location',
        { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy },
      ),
    isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true),
    onState,
  });
  loop.start();
  return loop;
}

export function stopSharingLoop() {
  if (loop) {
    loop.stop();
    loop = null;
  }
}

export function sharingLoopSnapshot() {
  return loop ? loop.snapshot() : null;
}
