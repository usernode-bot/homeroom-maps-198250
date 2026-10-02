// Saved places HTTP routes, mounted at /api/saved. Every route sits behind the
// app's auth gate (all /api/* requests need a verified platform token), so
// req.user is always present here and the caller's id is the only user_id any
// query ever sees.
//
//   GET    /                      lists + the caller's saved place ids
//   GET    /lists                 the caller's lists, with real item counts
//   POST   /lists                 create a custom list
//   GET    /lists/:id             one list and its contents
//   PATCH  /lists/:id             rename a custom list
//   DELETE /lists/:id             delete a CUSTOM list (never its places)
//   POST   /lists/:ref/items      add a saved place to a list
//   DELETE /lists/:ref/items      remove a place from a list
//   GET    /places                the caller's saved places
//   POST   /places                save a place (optionally into a list)
//   DELETE /places/:placeId       unsave a place
//   GET    /places/:placeId/status  whether the caller has saved this place
//
// `:ref` is either a default list slug (favorites, want_to_visit, travel,
// restaurants) or a numeric list id.
'use strict';

const express = require('express');
const model = require('./model');

function createSavedRouter({ store }) {
  const router = express.Router();

  function viewerOf(req) {
    return { id: String(req.user.id), username: String(req.user.username || '') };
  }

  // Express 4 does not forward rejected promises, so every async handler goes
  // through this: typed SavedErrors become their own status and code, anything
  // else reaches the app's central error handler.
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
    '/',
    handle(async (viewer) => {
      const lists = await store.listLists(viewer.id);
      const savedPlaceIds = await store.savedPlaceIds(viewer.id);
      return { lists, savedPlaceIds };
    }),
  );

  router.get(
    '/lists',
    handle(async (viewer) => ({ lists: await store.listLists(viewer.id) })),
  );
  router.post('/lists', handle((viewer, req) => store.createList(viewer.id, req.body)));
  router.get('/lists/:id', handle((viewer, req) => store.getList(viewer.id, req.params.id)));
  router.patch('/lists/:id', handle((viewer, req) => store.renameList(viewer.id, req.params.id, req.body)));
  router.delete('/lists/:id', handle((viewer, req) => store.deleteList(viewer.id, req.params.id)));

  router.post(
    '/lists/:ref/items',
    handle((viewer, req) => store.addToList(viewer.id, req.params.ref, req.body)),
  );
  router.delete(
    '/lists/:ref/items',
    handle((viewer, req) => {
      const placeId = (req.body && req.body.placeId) || req.query.placeId;
      return store.removeFromList(viewer.id, req.params.ref, placeId);
    }),
  );

  router.get(
    '/places',
    handle(async (viewer) => ({ places: await store.listPlaces(viewer.id) })),
  );
  router.post('/places', handle((viewer, req) => store.save(viewer.id, req.body)));
  router.get(
    '/places/:placeId/status',
    handle(async (viewer, req) => ({
      placeId: model.validatePlaceId(req.params.placeId),
      saved: await store.isSaved(viewer.id, req.params.placeId),
    })),
  );
  router.delete(
    '/places/:placeId',
    handle((viewer, req) => store.unsave(viewer.id, req.params.placeId)),
  );

  return router;
}

module.exports = { createSavedRouter };
