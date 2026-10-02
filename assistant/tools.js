// Read tools — the only way a fact reaches an answer.
//
// Every tool is a thin, read-only wrapper over an EXISTING service: search
// (search/index.js), places (places/index.js), routing (routing/index.js),
// trips (trips/store.js), saved places (saved/store.js) and community/reports
// (community/store.js, reports/store.js). Nothing here writes, and nothing
// here invents data: a tool returns exactly what its service returned, and a
// service failure becomes a typed `{ error: { code, message } }` the model is
// told about so it can say it does not know rather than guess.
//
// Ownership: the viewer is always the verified `req.user.id`/`username` from
// the route, never a body field. Every store call is already owner-scoped,
// and a trip, list or proposal belonging to someone else surfaces as
// not_found through the store's existing rule, so this layer never leaks
// another person's data.
//
// There is deliberately NO getMapContext tool: map context is client-side,
// user-provided and non-authoritative. It is sent to the model only as
// labelled context (see prompt.js) and is never returned as a tool result,
// so it can never become a "fact" an answer quotes.
'use strict';

// The Anthropic tool schemas handed to the proxy. Inputs are deliberately
// small: the model chooses a query or an id, never free-form SQL or a URL.
const TOOL_DEFINITIONS = [
  {
    name: 'search_places',
    description:
      'Search the world for places, addresses, cities, streets and points of interest. Returns real results with names and coordinates. Use this for any question about where something is or what places exist in an area.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, for example "coffee in Berlin".' },
        limit: { type: 'integer', description: 'How many results to return (1 to 10).', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_place_details',
    description:
      'Fetch deeper detail for one place id previously returned by search_places: phone, website, opening hours, rating and status. May answer that place detail is not configured, in which case say so honestly.',
    input_schema: {
      type: 'object',
      properties: { placeId: { type: 'string', description: 'A place id from search_places.' } },
      required: ['placeId'],
    },
  },
  {
    name: 'get_directions',
    description:
      'Calculate a route between two points. Returns distance, duration and a summary when a route exists. Modes other than driving may be unavailable.',
    input_schema: {
      type: 'object',
      properties: {
        origin: {
          type: 'object',
          properties: { lat: { type: 'number' }, lng: { type: 'number' } },
          required: ['lat', 'lng'],
        },
        destination: {
          type: 'object',
          properties: { lat: { type: 'number' }, lng: { type: 'number' } },
          required: ['lat', 'lng'],
        },
        mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'motorcycle', 'transit'] },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'get_trips',
    description:
      "List the signed-in person's trips and, when a tripId is given, that trip's days and stops. Only the person's own trips are visible.",
    input_schema: {
      type: 'object',
      properties: { tripId: { type: 'string', description: 'Optional trip id to open one trip.' } },
    },
  },
  {
    name: 'get_saved_places',
    description:
      "List the signed-in person's own saved places. Only their own saved places are visible.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_community_information',
    description:
      'Read community proposals or map reports. Use tab "proposals" for ideas and votes, "reports" for reported map issues.',
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

function toolError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function num(v, digits = 1) {
  return Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : v;
}

// SearchResult -> a compact, real-only summary. Nothing is invented: an
// absent field is omitted rather than filled.
function searchSummary(r) {
  const out = { id: r.id, name: r.name, kind: r.kind };
  if (r.detail && r.detail !== r.name) out.detail = r.detail;
  if (r.addressLine) out.address = r.addressLine;
  if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
    out.lat = num(r.lat, 5);
    out.lon = num(r.lon, 5);
  }
  out.source = r.provider;
  return out;
}

function placeSummary(place) {
  const out = { id: place.id, name: place.name };
  if (place.category) out.category = place.category;
  if (place.address) out.address = place.address;
  if (place.coordinates) {
    out.lat = num(place.coordinates.lat, 5);
    out.lon = num(place.coordinates.lon, 5);
  }
  if (place.rating) out.rating = place.rating;
  if (place.openingHours) out.openingHours = place.openingHours;
  if (place.phone) out.phone = place.phone;
  if (place.website) out.website = place.website;
  if (place.businessStatus) out.businessStatus = place.businessStatus;
  out.source = place.dataSource;
  return out;
}

function routeSummary(route) {
  const out = { mode: route.mode };
  if (Number.isFinite(route.distance)) out.distanceMeters = Math.round(route.distance);
  if (Number.isFinite(route.duration)) out.durationSeconds = Math.round(route.duration);
  if (route.summary) out.summary = route.summary;
  out.provider = route.provider;
  return out;
}

// The dispatcher. `services` is injected (server.js wires the real ones; a
// test wires stubs) so the module imports no singleton and is easy to drive.
async function dispatch(name, input, { viewer, services } = {}) {
  const args = input && typeof input === 'object' ? input : {};
  try {
    if (name === 'search_places') {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      if (!q) throw toolError('invalid_query', 'A search query is required.');
      if (q.length > 200) throw toolError('invalid_query', 'That search query is too long.');
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 6));
      const out = await services.search(q, limit);
      return { results: (out && out.results ? out.results : []).map(searchSummary) };
    }

    if (name === 'get_place_details') {
      const id = typeof args.placeId === 'string' ? args.placeId.trim() : '';
      if (!id) throw toolError('invalid_query', 'A place id is required.');
      const out = await services.getPlace(id);
      return { place: placeSummary(out.place) };
    }

    if (name === 'get_directions') {
      const mode = typeof args.mode === 'string' ? args.mode : undefined;
      const out = await services.getDirections({
        origin: args.origin,
        destination: args.destination,
        mode,
      });
      const routes = (out && out.routes ? out.routes : []).map((r) => ({ ...routeSummary(r), provider: out.provider }));
      return { provider: out && out.provider, mode: out && out.mode, routes };
    }

    if (name === 'get_trips') {
      if (args.tripId) {
        const trip = await services.getTrip(viewer, String(args.tripId));
        return {
          trip: {
            id: trip.id,
            name: trip.name,
            destination: trip.destination ? trip.destination.name : null,
            startDate: trip.startDate,
            endDate: trip.endDate,
            days: (trip.days || []).map((d) => ({
              id: d.id,
              date: d.date,
              items: (d.items || []).map((i) => ({
                id: i.id,
                placeId: i.placeId,
                name: i.placeSnapshot ? i.placeSnapshot.name : null,
                startTime: i.startTime,
                notes: i.notes,
              })),
            })),
          },
        };
      }
      const list = await services.listTrips(viewer);
      return {
        trips: (list && list.items ? list.items : []).map((t) => ({
          id: t.id,
          name: t.name,
          destination: t.destination ? t.destination.name : null,
          startDate: t.startDate,
          endDate: t.endDate,
          dayCount: t.dayCount,
          itemCount: t.itemCount,
        })),
      };
    }

    if (name === 'get_saved_places') {
      const places = await services.listSaved(viewer);
      return {
        places: (Array.isArray(places) ? places : []).map((p) => ({
          placeId: p.id,
          name: p.name,
          address: p.address,
          category: p.category,
          lat: p.lat == null ? null : num(p.lat, 5),
          lon: p.lng == null ? null : num(p.lng, 5),
        })),
      };
    }

    if (name === 'get_community_information') {
      const tab = args.tab === 'reports' ? 'reports' : 'proposals';
      const view = typeof args.view === 'string' ? args.view : 'recent';
      if (tab === 'reports') {
        const out = await services.listReports(viewer, { view, limit: 10 });
        return {
          tab,
          view,
          items: (out && out.items ? out.items : []).map((r) => ({
            id: r.id,
            type: r.type,
            typeLabel: r.typeLabel,
            status: r.effectiveStatus || r.status,
            place: r.place ? r.place.id : null,
            lat: r.lat == null ? null : num(r.lat, 5),
            lng: r.lng == null ? null : num(r.lng, 5),
            reporter: r.reporter ? r.reporter.username : null,
          })),
        };
      }
      const out = await services.listProposals(viewer, { view, limit: 10 });
      return {
        tab,
        view,
        items: (out && out.items ? out.items : []).map((p) => ({
          id: p.id,
          title: p.title,
          category: p.category,
          status: p.status,
          votes: p.votes,
          author: p.author ? p.author.username : null,
        })),
      };
    }

    throw toolError('unknown_tool', `"${name}" is not a tool this app provides.`);
  } catch (err) {
    // Every failure is reported as a typed tool error; the model is told so
    // it can answer honestly ("that is not available") rather than pretend.
    return {
      error: {
        code: (err && err.code) || 'tool_error',
        message: (err && err.message) || 'The tool failed.',
      },
    };
  }
}

module.exports = { TOOL_DEFINITIONS, dispatch, toolError };
