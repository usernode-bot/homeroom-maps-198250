// Trip HTTP routes, mounted at /api/trips. Every route sits behind the app's
// auth gate (all /api/* requests need a verified platform token), so req.user
// is always present here and is the ONLY ownership source. Nothing about a
// trip's owner is ever read from the request body.
//
//   GET    /                       the viewer's trips
//   GET    /?demo=1                the staging demo trip (staging only)
//   POST   /                       create (days are generated from the dates)
//   GET    /:id                    one trip with its days and items
//   PATCH  /:id                    edit name/destination/dates
//   DELETE /:id                    delete the trip and everything in it
//   POST   /:id/days/:dayId/items  add a place reference to a day
//   PATCH  /:id/items/:itemId      edit an item
//   DELETE /:id/items/:itemId      remove an item (positions renumber)
//   POST   /:id/items/:itemId/move reorder within or between days
'use strict';

const express = require('express');
const model = require('./model');

function createTripsRouter({ store, isStaging = false }) {
  const router = express.Router();

  function viewerOf(req) {
    return { id: String(req.user.id), username: String(req.user.username || '') };
  }

  // Express 4 does not forward rejected promises, so every async handler goes
  // through this: typed TripErrors become their own status and code, anything
  // else reaches the app's central error handler.
  const handle = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(viewerOf(req), req));
    } catch (err) {
      if (err instanceof model.TripError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
        });
      }
      return next(err);
    }
  };

  router.get(
    '/',
    handle(async (viewer, req) => {
      // The sanctioned request-time demo state: read-only, staging only, and
      // never a write from a normal route. Production falls through to the
      // viewer's own (honestly empty) list.
      if (isStaging && req.query.demo === '1') {
        const trip = await store.getDemo();
        if (trip) return { items: [{ ...trip, dayCount: trip.days.length }], demo: true };
        return { items: [], demo: true };
      }
      return store.list(viewer);
    }),
  );

  router.get('/:id', handle((viewer, req) => store.get(viewer, req.params.id)));
  router.post('/', handle((viewer, req) => store.create(viewer, req.body)));
  router.patch('/:id', handle((viewer, req) => store.update(viewer, req.params.id, req.body)));
  router.delete('/:id', handle((viewer, req) => store.remove(viewer, req.params.id)));

  router.post(
    '/:id/days/:dayId/items',
    handle((viewer, req) => store.addItem(viewer, req.params.id, req.params.dayId, req.body)),
  );
  router.patch(
    '/:id/items/:itemId',
    handle((viewer, req) => store.updateItem(viewer, req.params.id, req.params.itemId, req.body)),
  );
  router.delete(
    '/:id/items/:itemId',
    handle((viewer, req) => store.removeItem(viewer, req.params.id, req.params.itemId)),
  );
  router.post(
    '/:id/items/:itemId/move',
    handle((viewer, req) => store.moveItem(viewer, req.params.id, req.params.itemId, req.body)),
  );

  return router;
}

module.exports = { createTripsRouter };
