// Action model — pure, import-free rules for the ONE thing an assistant turn
// may propose and the user may confirm.
//
// An "action" is a proposal to touch the app, never a mutation. This module
// validates one action object. It does not import a store, open a
// transaction, or run any SQL: the actual write always goes through the
// EXISTING domain endpoint (listed below) after the person taps confirm on
// the client. That split is the security boundary the spec pins: the
// assistant model can steer a tool, but nothing it emits executes without a
// validated, user-confirmed action object.
//
// Two phases, deliberately separate:
//   validateActionShape(raw)        synchronous, no I/O: allowlist, required
//                                   fields, types, value ranges.
//   normalizeAction(raw, deps)      async: shape + the ownership precondition
//                                   for the one owner-scoped action, using an
//                                   injected trip reader.
//
// `deps.getTrip(viewer, tripId)` is the trip store's own owner-scoped read
// (trips/store.js get()), so a trip belonging to someone else reports
// not_found through the app's existing non-disclosure rule rather than
// leaking existence. Nothing here writes.
'use strict';

class ActionError extends Error {
  constructor(code, message, { fields = null } = {}) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.fields = fields;
  }
}

function actionError(code, message, fields) {
  return new ActionError(code, message, { fields });
}

// The allowlist. Every entry names the existing endpoint the client issues
// AFTER confirmation; `write` is true for the two that mutate domain data.
// No new write endpoint is introduced by Phase 11.
const ACTION_TOOLS = {
  save_place: {
    write: true,
    endpoint: 'POST /api/saved/places',
    fields: { place: 'place', listRef: 'listRef?' },
  },
  add_trip_item: {
    write: true,
    endpoint: 'POST /api/trips/:tripId/days/:dayId/items',
    fields: { tripId: 'id', dayId: 'id', place: 'place' },
  },
  show_route: {
    write: false,
    endpoint: 'GET /api/directions',
    fields: { destination: 'point', origin: 'point?', mode: 'mode?' },
  },
  open_community: {
    write: false,
    endpoint: 'community',
    fields: { tab: 'tab', view: 'view?' },
  },
};

const MODES = new Set(['driving', 'walking', 'cycling', 'motorcycle', 'transit']);
const TABS = new Set(['proposals', 'reports']);
const VIEWS = new Set(['recent', 'popular', 'nearby', 'implemented', 'mine']);

function trimmed(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function inRange(v, lo, hi) {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

// A place reference: the real id the search stack gives a result, plus the
// display values a card needs. id and name are required; everything else is
// optional and carried only when present.
function validatePlace(raw, fields, key) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fields[key] = 'A place is required.';
    return null;
  }
  const id = trimmed(raw.id);
  const name = trimmed(raw.name);
  if (!id) fields[key] = 'The place needs an id.';
  else if (id.length > 300) fields[key] = 'That place id is too long.';
  if (!name) fields[key] = 'The place needs a name.';
  else if (name.length > 200) fields[key] = 'That place name is too long.';
  if (fields[key]) return null;
  const out = { id, name };
  if (typeof raw.category === 'string' && raw.category) out.category = raw.category.slice(0, 120);
  if (typeof raw.subcategory === 'string' && raw.subcategory) out.subcategory = raw.subcategory.slice(0, 120);
  if (typeof raw.address === 'string' && raw.address) out.address = raw.address.slice(0, 300);
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (inRange(lat, -90, 90) && inRange(lng, -180, 180)) {
    out.lat = lat;
    out.lng = lng;
  }
  return out;
}

// A coordinate point (route origin/destination). A name is optional and is
// display-only, never a grounding for the answer.
function validatePoint(raw, fields, key, { required }) {
  if (raw == null || raw === '') {
    if (required) fields[key] = 'A location is required.';
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fields[key] = 'The location is malformed.';
    return null;
  }
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!inRange(lat, -90, 90) || !inRange(lng, -180, 180)) {
    fields[key] = 'The location coordinates are out of range.';
    return null;
  }
  const out = { lat, lng };
  if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim().slice(0, 200);
  return out;
}

function validateId(raw, fields, key) {
  const value = trimmed(raw);
  if (!value) fields[key] = 'An id is required.';
  else if (value.length > 300) fields[key] = 'That id is too long.';
  return fields[key] ? null : value;
}

// Synchronous shape validation. Returns { tool, args } with normalized args,
// or throws an ActionError('unknown_tool' | 'invalid_action').
function validateActionShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw actionError('invalid_action', 'The action is malformed.');
  }
  const tool = trimmed(raw.tool);
  const spec = ACTION_TOOLS[tool];
  if (!spec) {
    throw actionError('unknown_tool', `"${tool || 'unknown'}" is not an action this app supports.`);
  }
  const body = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
  const fields = {};
  const args = {};

  if (tool === 'save_place') {
    const place = validatePlace(body.place, fields, 'place');
    if (place) args.place = place;
    if (body.listRef != null && body.listRef !== '') {
      const listRef = trimmed(body.listRef);
      if (!listRef || listRef.length > 120) fields.listRef = 'That list is not valid.';
      else args.listRef = listRef;
    }
  } else if (tool === 'add_trip_item') {
    const tripId = validateId(body.tripId, fields, 'tripId');
    const dayId = validateId(body.dayId, fields, 'dayId');
    const place = validatePlace(body.place, fields, 'place');
    if (tripId) args.tripId = tripId;
    if (dayId) args.dayId = dayId;
    if (place) args.place = place;
  } else if (tool === 'show_route') {
    const destination = validatePoint(body.destination, fields, 'destination', { required: true });
    const origin = validatePoint(body.origin, fields, 'origin', { required: false });
    if (destination) args.destination = destination;
    if (origin) args.origin = origin;
    if (body.mode != null && body.mode !== '') {
      const mode = trimmed(body.mode).toLowerCase();
      if (!MODES.has(mode)) fields.mode = 'That travel mode is not supported.';
      else args.mode = mode;
    }
  } else if (tool === 'open_community') {
    const tab = trimmed(body.tab).toLowerCase();
    if (!TABS.has(tab)) fields.tab = 'Choose proposals or reports.';
    else args.tab = tab;
    if (body.view != null && body.view !== '') {
      const view = trimmed(body.view).toLowerCase();
      if (!VIEWS.has(view)) fields.view = 'That community view is not supported.';
      else args.view = view;
    }
  }

  if (Object.keys(fields).length) {
    throw actionError('invalid_action', 'The action needs fixing.', fields);
  }
  return { tool, args };
}

// A short, human-readable English summary. The confirmation card renders its
// own localized copy from `args`; this is a fallback for logs and tests.
function describeAction(tool, args) {
  if (tool === 'save_place') {
    return args.listRef ? `Save ${args.place.name} to ${args.listRef}` : `Save ${args.place.name}`;
  }
  if (tool === 'add_trip_item') return `Add ${args.place.name} to the trip`;
  if (tool === 'show_route') return `Show the route to ${args.destination.name || 'the destination'}`;
  if (tool === 'open_community') return `Open community ${args.tab}`;
  return tool;
}

// Async normalization: shape validation plus the ownership precondition for
// add_trip_item. `deps.getTrip(viewer, tripId)` must be the owner-scoped read
// (an unowned trip throws not_found). It runs here ONLY to prove the trip is
// the viewer's; it performs no write and this module never calls a write
// method. Returns { tool, args, summary, write, endpoint }.
async function normalizeAction(raw, { viewer, getTrip } = {}) {
  const { tool, args } = validateActionShape(raw);
  const spec = ACTION_TOOLS[tool];
  if (tool === 'add_trip_item' && typeof getTrip === 'function') {
    try {
      await getTrip(viewer, args.tripId);
    } catch (err) {
      const code = err && err.code === 'not_found' ? 'not_found' : 'invalid_action';
      throw actionError(
        code,
        code === 'not_found' ? 'That trip does not exist.' : 'That trip could not be checked.',
        code === 'not_found' ? { tripId: 'That trip does not exist.' } : undefined,
      );
    }
  }
  return {
    tool,
    args,
    summary: describeAction(tool, args),
    write: Boolean(spec.write),
    endpoint: spec.endpoint,
  };
}

// The action tools as Anthropic tool schemas, so the model can PROPOSE one.
// Declaring them does not execute anything: routes.js collects an emitted
// action tool call as a proposal and never runs it, and the write only happens
// after the person confirms it on the client.
const ACTION_DEFINITIONS = [
  {
    name: 'save_place',
    description:
      "Propose saving a place to the person's saved places. Requires the person's confirmation before anything is saved.",
    input_schema: {
      type: 'object',
      properties: {
        place: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            address: { type: 'string' },
            category: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
          required: ['id', 'name'],
        },
        listRef: {
          type: 'string',
          description: 'Optional list slug or id; favorites, want_to_visit, travel, restaurants, or a custom list id.',
        },
      },
      required: ['place'],
    },
  },
  {
    name: 'add_trip_item',
    description:
      "Propose adding a place to one day of one of the person's trips. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        tripId: { type: 'string' },
        dayId: { type: 'string' },
        place: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            address: { type: 'string' },
            category: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
          required: ['id', 'name'],
        },
      },
      required: ['tripId', 'dayId', 'place'],
    },
  },
  {
    name: 'show_route',
    description: 'Propose showing a route on the Directions screen. Read-only, no write.',
    input_schema: {
      type: 'object',
      properties: {
        origin: {
          type: 'object',
          properties: { lat: { type: 'number' }, lng: { type: 'number' }, name: { type: 'string' } },
        },
        destination: {
          type: 'object',
          properties: { lat: { type: 'number' }, lng: { type: 'number' }, name: { type: 'string' } },
          required: ['lat', 'lng'],
        },
        mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'motorcycle', 'transit'] },
      },
      required: ['destination'],
    },
  },
  {
    name: 'open_community',
    description: 'Propose opening the Community screen, on proposals or reports. Read-only, no write.',
    input_schema: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: ['proposals', 'reports'] },
        view: { type: 'string', enum: ['recent', 'popular', 'nearby', 'implemented', 'mine'] },
      },
      required: ['tab'],
    },
  },
];

module.exports = {
  ACTION_DEFINITIONS,
  ActionError,
  actionError,
  ACTION_TOOLS,
  MODES,
  TABS,
  VIEWS,
  validateActionShape,
  describeAction,
  normalizeAction,
};
