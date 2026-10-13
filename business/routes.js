// Business HTTP routes, mounted at /api/business. Every route sits behind
// the app's auth gate (all /api/* requests need a verified platform token),
// so req.user is always present here — the same gate the community and
// reports routers rely on. NOTHING in this app is ever added to
// PUBLIC_API_PATHS: a claim carries contact details meant for the reviewer,
// so every route here answers only a signed-in person.
//
//   GET    /meta                          limits, statuses, viewer role
//   GET    /place/:placeId                profile + viewer claim + permission for a place
//   POST   /place/:placeId/claim          submit a claim { place, contactValue, evidence }
//   GET    /mine                          the viewer's own claims and businesses
//   POST   /claims/:id/withdraw           the claimant withdraws a pending claim
//   POST   /claims/:id/decision           a reviewer decides { status, reason?, note? }
//   GET    /queue?view=…                  the reviewer queue (reviewers only)
//   GET    /profiles/:id                  one profile (+ revisions/events for owner or reviewer)
//   PATCH  /profiles/:id                  the owner edits { name?, … }
//   POST   /profiles/:id/moderate         a reviewer suspends or reinstates { status }
//   POST   /profiles/:id/flag             flag a profile { reason? }
'use strict';

const express = require('express');
const model = require('./model');

function createBusinessRouter({ store, reviewers = new Set() }) {
  const router = express.Router();

  function viewerOf(req) {
    const username = String(req.user.username || '');
    return {
      id: String(req.user.id),
      username,
      reviewer: reviewers.has(username.toLowerCase()),
    };
  }

  // Express 4 does not forward rejected promises, so every async handler
  // goes through this: typed BusinessErrors become their own status and
  // code, anything else reaches the app's central error handler.
  const handle = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(viewerOf(req), req));
    } catch (err) {
      if (err instanceof model.BusinessError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
        });
      }
      return next(err);
    }
  };

  router.get(
    '/meta',
    handle(async (viewer) => ({
      limits: model.LIMITS,
      claimStatuses: model.CLAIM_STATUSES,
      rejectReasons: model.REJECT_REASONS,
      viewer: { id: viewer.id, username: viewer.username, reviewer: viewer.reviewer },
    })),
  );

  router.get('/place/:placeId', handle((viewer, req) => store.getForPlace(viewer, req.params.placeId)));
  router.post(
    '/place/:placeId/claim',
    handle((viewer, req) =>
      store.submitClaim(viewer, {
        ...((req.body && typeof req.body === 'object') ? req.body : {}),
        // The path segment is authoritative: a body place id never moves the
        // claim to a different place than the URL named.
        place: { ...((req.body && req.body.place) || {}), id: req.params.placeId },
      }),
    ),
  );
  router.get('/mine', handle((viewer) => store.listMine(viewer)));
  router.post('/claims/:id/withdraw', handle((viewer, req) => store.withdrawClaim(viewer, req.params.id)));
  router.post(
    '/claims/:id/decision',
    handle((viewer, req) => store.decideClaim(viewer, req.params.id, req.body)),
  );
  router.get('/queue', handle((viewer, req) => store.listQueue(viewer, req.query)));
  router.get('/profiles/:id', handle((viewer, req) => store.getProfile(viewer, req.params.id)));
  router.patch('/profiles/:id', handle((viewer, req) => store.updateProfile(viewer, req.params.id, req.body)));
  router.post(
    '/profiles/:id/moderate',
    handle((viewer, req) => store.moderate(viewer, req.params.id, req.body)),
  );
  router.post(
    '/profiles/:id/flag',
    handle((viewer, req) => store.flag(viewer, req.params.id, req.body && req.body.reason)),
  );

  return router;
}

module.exports = { createBusinessRouter };
