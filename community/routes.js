// Community HTTP routes, mounted at /api/community. Every route sits behind
// the app's auth gate (all /api/* requests need a verified platform token),
// so req.user is always present here.
//
//   GET    /meta                       categories, statuses, viewer role
//   GET    /proposals?view=…           feed: recent | popular | nearby | implemented | mine
//   GET    /proposals/:id              one proposal with its status history
//   POST   /proposals                  create (draft, or published with publish: true)
//   PATCH  /proposals/:id              edit, where the status allows it
//   POST   /proposals/:id/status       move along the lifecycle { status }
//   PUT    /proposals/:id/vote         cast or change a vote { value: 1 | -1 }
//   DELETE /proposals/:id/vote         withdraw your vote
'use strict';

const express = require('express');
const model = require('./model');

function createCommunityRouter({ store, reviewers = new Set() }) {
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
  // goes through this: typed CommunityErrors become their own status and
  // code, anything else reaches the app's central error handler.
  const handle = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(viewerOf(req), req));
    } catch (err) {
      if (err instanceof model.CommunityError) {
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
      categories: model.CATEGORIES,
      statuses: model.STATUSES,
      views: model.FEED_VIEWS,
      limits: model.LIMITS,
      viewer: { id: viewer.id, username: viewer.username, reviewer: viewer.reviewer },
    })),
  );

  router.get('/proposals', handle((viewer, req) => store.list(viewer, req.query)));
  router.get('/proposals/:id', handle((viewer, req) => store.get(viewer, req.params.id)));
  router.post('/proposals', handle((viewer, req) => store.create(viewer, req.body)));
  router.patch('/proposals/:id', handle((viewer, req) => store.update(viewer, req.params.id, req.body)));
  router.post(
    '/proposals/:id/status',
    handle((viewer, req) => store.transition(viewer, req.params.id, req.body && req.body.status)),
  );
  router.put(
    '/proposals/:id/vote',
    handle((viewer, req) => store.vote(viewer, req.params.id, req.body && req.body.value)),
  );
  router.delete('/proposals/:id/vote', handle((viewer, req) => store.unvote(viewer, req.params.id)));

  return router;
}

module.exports = { createCommunityRouter };
