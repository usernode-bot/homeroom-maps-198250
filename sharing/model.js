// Location sharing (Phase 12F) — the rules, pure and database-free.
//
// Everything here is deliberately pure so it can be tested with an injected
// clock and no Postgres: duration whitelist, recipient normalization, fix
// validation and coordinate minimization. store.js enforces these same rules
// against the database; routes.js parses HTTP bodies through this module and
// nothing else, so a rule can never be bypassed by a different call site.
//
// The privacy posture lives here in one place: coordinates are truncated to
// 4 decimal places (~11 m) and accuracy is ceiled to whole metres BEFORE
// anything is stored, so no more-precise value ever exists server-side to
// leak — not into the table, a log, an error or an unauthorized response.
'use strict';

class SharingError extends Error {
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message);
    this.name = 'SharingError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

// The only durations a share may have. There is deliberately no "until I
// turn it off": every share ends by itself, and the whitelist is the whole
// contract.
const DURATIONS = [60, 480, 1440];

// The most people a single share may name.
const MAX_RECIPIENTS = 20;

// A session id is a BIGSERIAL; malformed values are a 404, never a 500, and
// the same rule the reports store uses.
function parseId(raw) {
  if (!/^\d{1,18}$/.test(String(raw))) {
    throw new SharingError('not_found', 'That share does not exist.', { status: 404 });
  }
  return String(raw);
}

// The duration must be one of the whitelist values, exactly.
function validateDuration(value) {
  const minutes = Number(value);
  if (!DURATIONS.includes(minutes)) {
    throw new SharingError(
      'invalid_request',
      'Choose how long to share for.',
      { fields: { durationMinutes: 'Pick 1 hour, 8 hours or 24 hours.' } },
    );
  }
  return minutes;
}

// The fixed end time: created_at + duration, computed once at creation and
// never extended. `now` is injectable so tests can pin the clock.
function expiresAtFor(durationMinutes, now = new Date()) {
  return new Date(new Date(now).getTime() + durationMinutes * 60_000);
}

// Normalize the recipient handles a start request names: strings only,
// trimmed, duplicates removed case-insensitively (first spelling wins; the
// canonical casing comes from the directory lookup later), the caller
// excluded, and the cap enforced. The output is the list of handles to
// resolve; it does not decide who is real — the member roster does.
function normalizeRecipientHandles(rawHandles, { viewerUsername }) {
  if (!Array.isArray(rawHandles)) {
    throw new SharingError(
      'invalid_request',
      'Choose who will see your location.',
      { fields: { recipients: 'Pick at least one person.' } },
    );
  }
  const seen = new Set();
  const handles = [];
  for (const raw of rawHandles) {
    if (typeof raw !== 'string') continue;
    const handle = raw.trim();
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  if (!handles.length) {
    throw new SharingError(
      'invalid_request',
      'Choose who will see your location.',
      { fields: { recipients: 'Pick at least one person.' } },
    );
  }
  if (handles.length > MAX_RECIPIENTS) {
    throw new SharingError(
      'invalid_request',
      `A share can name at most ${MAX_RECIPIENTS} people.`,
      { fields: { recipients: `Pick at most ${MAX_RECIPIENTS} people.` } },
    );
  }
  const self = String(viewerUsername || '').toLowerCase();
  if (self && handles.some((h) => h.toLowerCase() === self)) {
    throw new SharingError(
      'invalid_request',
      'You are already the one sharing.',
      { fields: { recipients: 'You cannot share with yourself.' } },
    );
  }
  return handles;
}

// Truncate toward zero to `decimals` places — never round up, so the stored
// point never claims precision it does not have and never drifts outward.
function truncateTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.trunc(Number(value) * factor) / factor;
}

// Validate and minimize one position fix. Returns the values that may be
// stored; anything a device could send that is not a usable coordinate is an
// invalid_request. Accuracy is ceiled (never understated) and capped at
// 100000 m, so the advertised uncertainty is always an overestimate.
function validateFix(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new SharingError('invalid_request', 'That position is not a valid location.', {
      fields: { lat: 'Enter a latitude between -90 and 90.' },
    });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new SharingError('invalid_request', 'That position is not a valid location.', {
      fields: { lng: 'Enter a longitude between -180 and 180.' },
    });
  }
  let accuracy = null;
  if (raw.accuracy != null && raw.accuracy !== '') {
    const n = Number(raw.accuracy);
    if (!Number.isFinite(n) || n < 0) {
      throw new SharingError('invalid_request', 'That position is not a valid location.', {
        fields: { accuracy: 'Accuracy must be a non-negative number of metres.' },
      });
    }
    accuracy = Math.min(Math.ceil(n), 100000);
  }
  return { lat: truncateTo(lat, 4), lng: truncateTo(lng, 4), accuracy };
}

module.exports = {
  SharingError,
  DURATIONS,
  MAX_RECIPIENTS,
  parseId,
  validateDuration,
  expiresAtFor,
  normalizeRecipientHandles,
  validateFix,
};
