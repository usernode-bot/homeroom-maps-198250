// Location sharing client core (Phase 12F) — DOM-free, dependency-free.
//
// Three things live here, exactly like navigation-core.js keeps its session
// machine apart from the screen:
//
//   createSharingLoop  the device update loop: one fix every ~30 s while the
//                      share is active, the app is visible and the device is
//                      online; honest pauses and hard stops.
//   consentedTo        per-page-load consent memory. Starting or resuming a
//                      share in this page load marks it; a reload wipes it,
//                      which is what makes "no silent restart" real.
//   ageLabel / ...     the staleness copy helpers, with `t` injected so this
//                      file stays free of DOM and i18n imports.
//
// The loop never invents a fix, never retries after a person's decision
// (permission denied, stop), and never posts anything without a real fix.

// Loop states, all of which the sharing screen can name in the device-status
// line. Not every state is an error: OFFLINE is an honest pause.
export const SHARING_LOOP = Object.freeze({
  ACTIVE: 'active', // posting on cadence
  OFFLINE: 'offline', // device offline: paused, resuming on its own
  FIX_FAILED: 'fix_failed', // GPS or one post failed: still trying
  PERMISSION_LOST: 'permission_lost', // a person's decision: stopped for good
  ENDED: 'ended', // the server said the share is over
});

// The update cadence. Fixed, and visible in the UI ("Last posted ... ago").
export const SHARING_INTERVAL_MS = 30_000;

// How long after the last received fix an incoming row counts as stale
// (muted on the screen) versus very stale (over an hour: no live share).
export const STALE_AFTER_SECONDS = 300;
export const VERY_STALE_AFTER_SECONDS = 3600;

export function isStale(fixAgeSeconds) {
  return typeof fixAgeSeconds === 'number' && fixAgeSeconds > STALE_AFTER_SECONDS;
}

export function isVeryStale(fixAgeSeconds) {
  return typeof fixAgeSeconds === 'number' && fixAgeSeconds >= VERY_STALE_AFTER_SECONDS;
}

// The "Last seen 26 min ago" line for an incoming row. `seconds` is the
// SERVER-computed age; null means no fix has ever arrived.
export function ageLabel(seconds, { t }) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return t('sharing.noUpdateYet');
  }
  if (seconds >= VERY_STALE_AFTER_SECONDS) return t('sharing.noUpdateHour');
  const minutes = Math.max(1, Math.round(seconds / 60));
  return t('sharing.lastSeen', { age: minutes + ' ' + t('sharing.minShort') });
}

// "Expires in 42 min" / "Expires in 3 h 5 min" for the owner's own card.
export function expiresInLabel(seconds, { t }) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return t('sharing.sessionEndedNote');
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  let age;
  if (h > 0 && m > 0) age = h + ' ' + t('sharing.hourShort') + ' ' + m + ' ' + t('sharing.minShort');
  else if (h > 0) age = h + ' ' + t('sharing.hourShort');
  else age = minutes + ' ' + t('sharing.minShort');
  return t('sharing.expiresIn', { age });
}

// The consent line in the start sheet, composed from the chosen people and
// the chosen duration's end time. Pure composition — the screen supplies the
// formatted end time.
export function consentText(usernames, endsAtText, { t }) {
  return t('sharing.consent', { names: usernames.join(', '), ends: endsAtText });
}

// The device-status line for the owner's card, from a loop snapshot (or
// null when there is no loop, e.g. before the person consents).
export function deviceStatusText(snapshot, { t }) {
  if (!snapshot) return null;
  switch (snapshot.state) {
    case SHARING_LOOP.ACTIVE:
      return t('sharing.postingOn');
    case SHARING_LOOP.OFFLINE:
      return t('sharing.postingPausedOffline');
    case SHARING_LOOP.FIX_FAILED:
      return t('sharing.postingFailed');
    case SHARING_LOOP.PERMISSION_LOST:
      return t('sharing.locationOffTitle');
    case SHARING_LOOP.ENDED:
      return t('sharing.sessionEndedNote');
    default:
      return null;
  }
}

// Per-page-load consent memory. Deliberately module-level, NOT localStorage:
// a reload must never resume posting by itself, so the memory must die with
// the page. `consentToSession(id)` is called only from a person's own tap —
// starting a share, or the "Resume sharing updates?" action.
let consentedSessionId = null;

export function consentToSession(id) {
  consentedSessionId = String(id);
}

export function consentedTo(id) {
  return id != null && String(id) === consentedSessionId;
}

export function forgetConsent() {
  consentedSessionId = null;
}

// The update loop. Injected dependencies keep it DOM-free and testable:
//
//   getFix()      -> Promise<{lat, lng, accuracy}>   the device's real fix
//   postLocation(fix) -> Promise                     one POST to the real route
//   isOnline()    -> boolean                          navigator.onLine, injected
//   schedule      -> (fn, ms) => cancel               timers, injected
//   now           -> () => ms                         clock, injected
//   onState       -> (snapshot) => void               the screen re-renders on it
//
// Failure classes:
//   getFix rejects with a permission reason (denied / declined /
//   not_declared / no_shell / ask_failed / reopening) -> PERMISSION_LOST and
//   the loop stops: updating again is the person's decision, never a retry.
//   postLocation rejects with the typed codes session_ended / not_found
//   -> ENDED and the loop stops: the share is over server-side.
//   Anything else -> OFFLINE when the device says it is offline, else
//   FIX_FAILED; both keep trying on the cadence.
export function createSharingLoop({
  sessionId,
  getFix,
  postLocation,
  isOnline = null,
  schedule = null,
  now = null,
  intervalMs = SHARING_INTERVAL_MS,
  onState = null,
}) {
  const sched = schedule || defaultSchedule;
  const clock = now || (() => Date.now());
  const online = isOnline || (() => true);

  let state = SHARING_LOOP.ACTIVE;
  let stopped = false;
  let inFlight = false;
  let cancelTimer = null;
  let lastFix = null;
  let lastPostedAt = null;
  let lastError = null;

  function snapshot() {
    return { sessionId: String(sessionId), state, lastFix, lastPostedAt, lastError };
  }

  function emit() {
    if (onState) {
      try {
        onState(snapshot());
      } catch {
        /* a listener must never break the loop */
      }
    }
  }

  function scheduleNext(ms) {
    if (stopped || cancelTimer) return;
    cancelTimer = sched(tick, ms);
  }

  function clearTimer() {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
  }

  function tick() {
    clearTimer();
    if (stopped || inFlight) return;
    if (state === SHARING_LOOP.ENDED || state === SHARING_LOOP.PERMISSION_LOST) return;

    if (!online()) {
      // An honest pause: nothing is posted, the share itself is untouched,
      // and the loop keeps checking so it can resume by itself.
      state = SHARING_LOOP.OFFLINE;
      emit();
      scheduleNext(5000);
      return;
    }

    inFlight = true;
    Promise.resolve()
      .then(() => getFix())
      .then((fix) => postLocation(fix).then(() => fix))
      .then((fix) => {
        inFlight = false;
        if (stopped) return;
        lastFix = fix;
        lastPostedAt = clock();
        lastError = null;
        // A recovery from OFFLINE / FIX_FAILED is part of the honest state:
        // the status line flips back on its own.
        state = SHARING_LOOP.ACTIVE;
        emit();
        scheduleNext(intervalMs);
      })
      .catch((err) => {
        inFlight = false;
        if (stopped) return;
        lastError = err && err.message ? err.message : String(err);
        const reason = err && err.reason;
        const code = err && err.code;

        // A person's decision (or the platform's): never retried.
        if (
          reason === 'denied' ||
          reason === 'declined' ||
          reason === 'not_declared' ||
          reason === 'no_shell' ||
          reason === 'ask_failed' ||
          reason === 'reopening'
        ) {
          state = SHARING_LOOP.PERMISSION_LOST;
          emit();
          return;
        }

        // The server says the share is over — expiry, stop, or an id that is
        // simply not ours. The loop stops; the screen re-reads /mine.
        if (code === 'session_ended' || code === 'not_found') {
          state = SHARING_LOOP.ENDED;
          emit();
          return;
        }

        state = online() ? SHARING_LOOP.FIX_FAILED : SHARING_LOOP.OFFLINE;
        emit();
        scheduleNext(intervalMs);
      });
  }

  return {
    start() {
      if (stopped) return null;
      tick();
      emit();
      return null;
    },
    // The screen re-renders (navigating away and back) while the loop lives
    // on: point the status updates at the new status slot.
    setOnState(next) {
      onState = typeof next === 'function' ? next : null;
      emit();
    },
    // Hidden frame: stop posting but keep the loop's identity, so the next
    // visible tick resumes the SAME share without re-asking anyone.
    setVisible(visible) {
      if (stopped) return;
      if (!visible) {
        clearTimer();
        return;
      }
      if (state === SHARING_LOOP.ENDED || state === SHARING_LOOP.PERMISSION_LOST) return;
      tick();
    },
    snapshot,
    stop() {
      stopped = true;
      clearTimer();
      cancelTimer = null;
    },
  };
}

function defaultSchedule(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}
