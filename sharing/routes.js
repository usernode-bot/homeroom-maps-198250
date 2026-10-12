// Location sharing HTTP routes (Phase 12F), mounted at /api/sharing.
//
// Every route sits behind the app's auth gate (all /api/* requests need a
// verified platform token), so req.user is always present here and is the
// ONLY ownership source — nothing about owners or recipients is ever read
// from a request body. Ownership and recipient membership are enforced in
// the store's SQL itself; this layer only parses bodies, applies the
// per-user rate limits and maps typed errors.
//
// The route table below is exhaustive and part of the contract: there is
// deliberately no endpoint that modifies a session after creation — nothing
// adds or removes a recipient, extends the expiry, re-opens an ended
// session, or takes ownership — so an invented path is the app's standard
// JSON 404 before any store code runs.
//
//   GET    /members                 the project roster (platform proxy, 60s cache)
//   POST   /sessions                start a share (fixed recipients + expiry)
//   GET    /sessions/mine           the caller's own active session (or null)
//   POST   /sessions/:id/location   the owner posts one position fix
//   DELETE /sessions/:id            the owner stops the share, erasing the fix
//   GET    /incoming                the caller's incoming (recipient) shares
//   POST   /incoming/:id/dismiss    the recipient hides one share for themselves
'use strict';

const express = require('express');
const model = require('./model');
const { SharingError } = model;

// Per-user token buckets. The clock is Date.now() here; the class is the
// same one the search and assistant stacks use.
const { TokenBucket } = require('../search/rate-limit');

// Position updates: capacity 10 with a refill of one per 3 s comfortably
// supports the ~30 s update cadence and rejects floods.
const LOCATION_BUCKET = { capacity: 10, refillPerSecond: 1 / 3 };
// Session creation: 5 per hour per user.
const CREATE_BUCKET = { capacity: 5, refillPerSecond: 5 / 3600 };

function bucketFor(map, key, { capacity, refillPerSecond }) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new TokenBucket({ capacity, refillPerSecond });
    map.set(key, bucket);
  }
  return bucket;
}

function createSharingRouter({ store, members, enabled = true }) {
  const router = express.Router();

  // The operator switch (LOCATION_SHARING_ENABLED). When off, every route
  // answers the established not_configured 501 and the screen shows the
  // honest unavailable state. This gates the FEATURE's availability — the
  // same code path runs in staging and production, exactly as the offline
  // and assistant switches do.
  if (!enabled) {
    router.use((_req, res) => {
      res.status(501).json({
        error: { code: 'not_configured', message: 'Location sharing is not available.' },
      });
    });
    return router;
  }

  const createBuckets = new Map();
  const locationBuckets = new Map();

  function viewerOf(req) {
    return { id: String(req.user.id), username: String(req.user.username || '') };
  }

  // The caller's forwarded iframe token, for the server-side platform
  // directory calls. The frontend already sends it as this header.
  function userTokenOf(req) {
    return req.headers['x-usernode-token'] || '';
  }

  // Express 4 does not forward rejected promises, so every async handler
  // goes through this: typed SharingErrors become their own status and code,
  // anything else reaches the app's central error handler. The error body is
  // exactly { error: { code, message } } — never session metadata, never a
  // coordinate. An undefined result is a bare 204; a handler that needs a
  // non-200 status (the 201 on create) sets it on res before returning.
  const handle = (fn) => async (req, res, next) => {
    try {
      const out = await fn(viewerOf(req), req, res);
      if (out === undefined) return res.status(204).end();
      return res.json(out);
    } catch (err) {
      if (err instanceof SharingError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
        });
      }
      return next(err);
    }
  };

  // GET /members — the roster proxy. On not_a_member or an upstream failure
  // it answers 200 { available: false, members: [] }, so the screen renders
  // without the people picker and never fails.
  router.get(
    '/members',
    handle(async (viewer, req) => {
      const result = await members.roster(userTokenOf(req));
      if (!result.available) return { available: false, members: [] };
      return { available: true, members: result.members };
    }),
  );

  // POST /sessions — start a share. Creation binds the session to the
  // authenticated caller (they become sharer_id), fixes its recipient list
  // and expiry permanently, and is the only place recipient rows are ever
  // inserted.
  router.post(
    '/sessions',
    handle(async (viewer, req, res) => {
      if (!bucketFor(createBuckets, viewer.id, CREATE_BUCKET).tryTake()) {
        throw new SharingError('rate_limited', 'Too many shares started. Try again later.', {
          status: 429,
        });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const durationMinutes = model.validateDuration(body.durationMinutes);
      const handles = model.normalizeRecipientHandles(body.recipients, {
        viewerUsername: viewer.username,
      });
      const resolved = await members.resolveRecipients(userTokenOf(req), handles, {
        viewerId: viewer.id,
      });
      if (!resolved.available) {
        throw new SharingError(
          'recipients_unavailable',
          'The member list could not be verified, so the share was not started. Try again.',
          { status: 503 },
        );
      }
      const session = await store.createSession(viewer, {
        expiresAt: model.expiresAtFor(durationMinutes),
        recipients: resolved.recipients,
      });
      res.status(201);
      return { session };
    }),
  );

  // GET /sessions/mine — the owner's own active session.
  router.get(
    '/sessions/mine',
    handle(async (viewer) => store.getMine(viewer)),
  );

  // POST /sessions/:id/location — the owner posts one fix.
  router.post(
    '/sessions/:id/location',
    handle(async (viewer, req) => {
      if (!bucketFor(locationBuckets, viewer.id, LOCATION_BUCKET).tryTake()) {
        throw new SharingError('rate_limited', 'Too many location updates. Try again shortly.', {
          status: 429,
        });
      }
      const fix = model.validateFix(req.body);
      return store.updateLocation(viewer, req.params.id, fix);
    }),
  );

  // DELETE /sessions/:id — the owner stops the share. Ending and erasing are
  // one atomic statement in the store; already-stopped own session is an
  // idempotent 204.
  router.delete(
    '/sessions/:id',
    handle(async (viewer, req) => store.stop(viewer, req.params.id)),
  );

  // GET /incoming — the shares the caller is a recipient of.
  router.get(
    '/incoming',
    handle(async (viewer) => store.listIncoming(viewer)),
  );

  // POST /incoming/:id/dismiss — the recipient hides one share for
  // themselves, on their own row only.
  router.post(
    '/incoming/:id/dismiss',
    handle(async (viewer, req) => store.dismiss(viewer, req.params.id)),
  );

  return router;
}

module.exports = { createSharingRouter };
