// Saved places HTTP routes, mounted at /api/saved. Every route sits behind
// the app's auth gate (all /api/* requests need a verified platform token),
// so req.user is always present here.
//
//   GET    /lists?view=mine|public            your lists (lazily ensured) | the public directory
//   POST   /lists                             create { name, emoji, visibility }
//   GET    /lists/:id?key=                    one list with its items (+ pending suggestions for the owner)
//   PATCH  /lists/:id                         owner: edit name / emoji / visibility
//   DELETE /lists/:id                         owner: delete the list and everything in it
//   POST   /lists/:id/items                   owner: add a place snapshot { place, note? }
//   PATCH  /lists/:id/items/:itemId           owner: edit the note { note }
//   DELETE /lists/:id/items/:itemId           owner: remove the place
//   POST   /lists/:id/suggestions             non-owner who can view: suggest { place, message? }
//   POST   /suggestions/:id/accept            owner: accept (inserts the item)
//   POST   /suggestions/:id/reject            owner: reject
//   GET    /items/:id/comments?key=           anyone who can view the list
//   POST   /items/:id/comments                anyone who can view the list { body }
//   DELETE /comments/:id                      the author, or the list owner
'use strict';

const express = require('express');
const model = require('./model');

// The Shared level's key rides on the query string for reads (?key=) and the
// deep link (&key=); writes never honour it — the owner's own token does the
// authenticating.
function keyOf(req) {
  const key = req.query.key;
  return typeof key === 'string' && key ? key : null;
}

function createSavedRouter({ store }) {
  const router = express.Router();

  function viewerOf(req) {
    return {
      id: String(req.user.id),
      username: String(req.user.username || ''),
    };
  }

  // Express 4 does not forward rejected promises, so every async handler
  // goes through this: typed SavedErrors become their own status and code,
  // anything else reaches the app's central error handler.
  const handle = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(viewerOf(req), req));
    } catch (err) {
      if (err instanceof model.SavedError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
        });
      }
      return next(err);
    }
  };

  router.get(
    '/lists',
    handle(async (viewer, req) =>
      req.query.view === 'public' ? store.listPublic(viewer, req.query) : store.listMine(viewer, req.query)),
  );
  router.post('/lists', handle(async (viewer, req) => store.create(viewer, req.body)));
  router.get(
    '/lists/:id',
    handle(async (viewer, req) => store.getDetail(viewer, req.params.id, { key: keyOf(req) })),
  );
  router.patch('/lists/:id', handle(async (viewer, req) => store.update(viewer, req.params.id, req.body)));
  router.delete('/lists/:id', handle(async (viewer, req) => store.remove(viewer, req.params.id)));
  router.post('/lists/:id/items', handle(async (viewer, req) => store.addItem(viewer, req.params.id, req.body)));
  router.patch(
    '/lists/:id/items/:itemId',
    handle(async (viewer, req) => store.updateItem(viewer, req.params.id, req.params.itemId, req.body)),
  );
  router.delete(
    '/lists/:id/items/:itemId',
    handle(async (viewer, req) => store.removeItem(viewer, req.params.id, req.params.itemId)),
  );
  router.post(
    '/lists/:id/suggestions',
    handle(async (viewer, req) => store.suggest(viewer, req.params.id, req.body)),
  );
  router.post(
    '/suggestions/:id/accept',
    handle(async (viewer, req) => store.decideSuggestion(viewer, req.params.id, 'accept')),
  );
  router.post(
    '/suggestions/:id/reject',
    handle(async (viewer, req) => store.decideSuggestion(viewer, req.params.id, 'reject')),
  );
  router.get(
    '/items/:id/comments',
    handle(async (viewer, req) => store.listComments(viewer, req.params.id, { key: keyOf(req) })),
  );
  router.post(
    '/items/:id/comments',
    handle(async (viewer, req) => store.addComment(viewer, req.params.id, req.body, { key: keyOf(req) })),
  );
  router.delete('/comments/:id', handle(async (viewer, req) => store.deleteComment(viewer, req.params.id)));

  return router;
}

module.exports = { createSavedRouter };
