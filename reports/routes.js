// Reports HTTP routes, mounted at /api/reports. Every route sits behind the
// app's auth gate (all /api/* requests need a verified platform token), so
// req.user is always present here. Same construction as
// community/routes.js — the same viewer shape, the same typed error
// envelope. Routes are defined relative to the mount point, matching the
// client contract in public/js/services/community.js:
//
//   GET    /meta                        types, statuses, viewer role, limits
//   GET    /?view=…                     feed: recent | nearby | mine
//   GET    /:id                         one report with its status history
//   POST   /                            create { type, lat, lng, … }
//   PUT    /:id/reaction                cast or change { value: 'confirm' | 'disagree' }
//   DELETE /:id/reaction                withdraw your reaction
//   POST   /:id/flag                    report abuse { reason? }, once per person
//   POST   /:id/status                  reviewer-only lifecycle move { status }
'use strict';

const express = require('express');
const model = require('./model');

function createReportsRouter({ store, reviewers = new Set() }) {
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
      types: model.TYPES,
      statuses: model.STATUSES,
      views: model.FEED_VIEWS,
      limits: model.LIMITS,
      viewer: { id: viewer.id, username: viewer.username, reviewer: viewer.reviewer },
    })),
  );

  router.get('/', handle((viewer, req) => store.list(viewer, req.query)));
  router.get('/:id', handle((viewer, req) => store.get(viewer, req.params.id)));
  router.post('/', handle((viewer, req) => store.create(viewer, req.body)));
  router.put(
    '/:id/reaction',
    handle((viewer, req) => store.setReaction(viewer, req.params.id, req.body && req.body.value)),
  );
  router.delete('/:id/reaction', handle((viewer, req) => store.removeReaction(viewer, req.params.id)));
  router.post(
    '/:id/flag',
    handle((viewer, req) => store.flag(viewer, req.params.id, req.body && req.body.reason)),
  );
  router.post(
    '/:id/status',
    handle((viewer, req) => store.transition(viewer, req.params.id, req.body && req.body.status)),
  );

  return router;
}

module.exports = { createReportsRouter };