// Allowlist projections for the /api/v1 developer API (Phase 12K).
//
// The rule is allow, never deny: each projector builds its output from
// explicitly named fields, so anything a domain service adds later — a new
// viewer-relative block, an internal id, a moderation field — does not leak
// into the public API by default. The one deliberate transformation: the
// community and reports projections drop the author's/reporter's platform
// user id and keep the username, which is already public in the app's own
// feeds, and drop the entire caller-relative viewer block, because an API
// key holder is not the viewer the internal routes rendered for.
'use strict';

// Attribution for the data a response carries. Every provider the app uses
// today is OpenStreetMap-derived, and the app's own surfaces already show
// this exact string (search/osmLine, docs/routing-provider-comparison.md).
// The map exists so a future non-OSM provider gets its own entry instead of
// silently inheriting one.
const PROVIDER_ATTRIBUTION = {
  photon: '© OpenStreetMap contributors',
  pelias: '© OpenStreetMap contributors',
  osrm: '© OpenStreetMap contributors',
};

function attributionFor(providerName) {
  return PROVIDER_ATTRIBUTION[String(providerName || '').toLowerCase()] || '© OpenStreetMap contributors';
}

// ---- search ----------------------------------------------------------------

// One search/suggest result. The internal shape is search/normalize.js's
// normalizeResult; the per-result `provider` field is dropped (the response
// carries one `provider` and one `attribution` at the top level).
function projectSearchResult(result) {
  if (!result || typeof result !== 'object') return null;
  const address = result.address || {};
  const pick = (v) => (typeof v === 'string' && v ? v : null);
  return {
    id: String(result.id || ''),
    kind: result.kind || 'other',
    name: result.name,
    localName: result.localName || null,
    detail: result.detail || result.name,
    address: {
      houseNumber: pick(address.houseNumber),
      street: pick(address.street),
      city: pick(address.city),
      state: pick(address.state),
      postcode: pick(address.postcode),
      country: pick(address.country),
      countryCode: pick(address.countryCode),
    },
    addressLine: result.addressLine || null,
    lat: Number(result.lat),
    lon: Number(result.lon),
  };
}

function projectSearchResponse(out) {
  const results = (Array.isArray(out && out.results) ? out.results : [])
    .map(projectSearchResult)
    .filter(Boolean);
  return {
    provider: out.provider,
    results,
    attribution: attributionFor(out.provider),
  };
}

// ---- routing ---------------------------------------------------------------

// A maneuver step inside a leg. Road names, references and maneuvers are
// public provider data; nothing caller-relative exists here, but the
// allowlist still names every field.
function projectStep(step) {
  if (!step || typeof step !== 'object') return null;
  const maneuver = step.maneuver || {};
  return {
    name: typeof step.name === 'string' ? step.name : null,
    ref: typeof step.ref === 'string' ? step.ref : null,
    distance: Number.isFinite(step.distance) ? step.distance : null,
    duration: Number.isFinite(step.duration) ? step.duration : null,
    maneuver: {
      type: maneuver.type || null,
      modifier: maneuver.modifier || null,
      location: Array.isArray(maneuver.location) ? maneuver.location : null,
    },
  };
}

function projectLeg(leg) {
  if (!leg || typeof leg !== 'object') return null;
  return {
    distance: Number.isFinite(leg.distance) ? leg.distance : null,
    duration: Number.isFinite(leg.duration) ? leg.duration : null,
    steps: (Array.isArray(leg.steps) ? leg.steps : []).map(projectStep).filter(Boolean),
  };
}

function projectRoute(route) {
  if (!route || typeof route !== 'object') return null;
  return {
    geometry: Array.isArray(route.geometry) ? route.geometry : [],
    distance: Number.isFinite(route.distance) ? route.distance : null,
    duration: Number.isFinite(route.duration) ? route.duration : null,
    summary: typeof route.summary === 'string' ? route.summary : null,
    legs: (Array.isArray(route.legs) ? route.legs : []).map(projectLeg).filter(Boolean),
  };
}

function projectRoutingResponse(out) {
  const routes = (Array.isArray(out && out.routes) ? out.routes : []).map(projectRoute).filter(Boolean);
  return {
    provider: out.provider,
    mode: out.mode,
    routes,
    attribution: attributionFor(out.provider),
  };
}

// ---- places ----------------------------------------------------------------

// Place summaries and details share one projector: the normalized place
// shape (places/index.js) is public by contract — name, address, coordinates
// and the provider's own detail fields. Everything listed stays; the
// projector exists so a future provider field must be ADDED here, not
// silently published.
function projectPlace(place) {
  if (!place || typeof place !== 'object') return null;
  const out = {};
  const keep = (key) => {
    if (place[key] !== undefined) out[key] = place[key];
  };
  for (const key of [
    'id',
    'name',
    'localName',
    'detail',
    'address',
    'addressLine',
    'lat',
    'lon',
    'category',
    'photos',
    'openingHours',
    'phone',
    'website',
    'rating',
    'businessStatus',
  ]) {
    keep(key);
  }
  return out;
}

function projectPlacesResponse(out) {
  const results = (Array.isArray(out && out.results) ? out.results : []).map(projectPlace).filter(Boolean);
  return {
    provider: out.provider,
    results,
    attribution: attributionFor(out.provider),
  };
}

function projectPlaceResponse(out) {
  const place = projectPlace(out && out.place);
  return {
    provider: out && out.provider,
    place,
    attribution: attributionFor(out && out.provider),
  };
}

// ---- community proposals ---------------------------------------------------

// Strip author.id and the whole viewer block; keep the username, content,
// status, tallies (always counted on read, never stored counters) and
// timestamps. distanceKm only exists on nearby views.
function projectProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  const author = proposal.author || {};
  const votes = proposal.votes || {};
  const out = {
    id: proposal.id,
    author: { username: author.username || null },
    title: proposal.title,
    description: proposal.description,
    category: proposal.category,
    categoryLabel: proposal.categoryLabel || null,
    location: proposal.location || null,
    attachments: Array.isArray(proposal.attachments) ? proposal.attachments : [],
    status: proposal.status,
    statusLabel: proposal.statusLabel || null,
    createdAt: proposal.createdAt || null,
    updatedAt: proposal.updatedAt || null,
    publishedAt: proposal.publishedAt || null,
    statusChangedAt: proposal.statusChangedAt || null,
    votes: { up: votes.up || 0, down: votes.down || 0, score: votes.score != null ? votes.score : (votes.up || 0) - (votes.down || 0) },
  };
  if (proposal.distanceKm != null) out.distanceKm = proposal.distanceKm;
  if (Array.isArray(proposal.history)) {
    out.history = proposal.history.map((event) => ({
      from: event.from,
      to: event.to,
      toLabel: event.toLabel || null,
      actor: event.actor || null,
      at: event.at || null,
    }));
  }
  return out;
}

function projectProposalFeed(feed) {
  return {
    view: feed && feed.view,
    items: (Array.isArray(feed && feed.items) ? feed.items : []).map(projectProposal).filter(Boolean),
    hasMore: Boolean(feed && feed.hasMore),
    nextOffset: feed && feed.hasMore ? feed.nextOffset : null,
    attribution: attributionFor(),
    ...(feed && feed.view === 'nearby' ? { near: feed.near, radiusKm: feed.radiusKm } : {}),
  };
}

// ---- reports ---------------------------------------------------------------

// Same rule: reporter.id and the viewer block out; username, content,
// tallies and derived expiry in. Reaction identities and flag records are
// never in the store's public projection to begin with.
function projectReport(report) {
  if (!report || typeof report !== 'object') return null;
  const reporter = report.reporter || {};
  const reactions = report.reactions || {};
  const out = {
    id: report.id,
    type: report.type,
    typeLabel: report.typeLabel || null,
    description: report.description,
    place: report.place || null,
    lat: report.lat,
    lng: report.lng,
    reporter: { username: reporter.username || null },
    status: report.status,
    statusLabel: report.statusLabel || null,
    effectiveStatus: report.effectiveStatus || null,
    expiresAt: report.expiresAt || null,
    createdAt: report.createdAt || null,
    updatedAt: report.updatedAt || null,
    reactions: { confirm: reactions.confirm || 0, disagree: reactions.disagree || 0 },
  };
  if (report.distanceKm != null) out.distanceKm = report.distanceKm;
  if (Array.isArray(report.history)) {
    out.history = report.history.map((event) => ({
      from: event.from,
      to: event.to,
      toLabel: event.toLabel || null,
      actor: event.actor || null,
      at: event.at || null,
    }));
  }
  return out;
}

function projectReportFeed(feed) {
  return {
    view: feed && feed.view,
    items: (Array.isArray(feed && feed.items) ? feed.items : []).map(projectReport).filter(Boolean),
    hasMore: Boolean(feed && feed.hasMore),
    nextOffset: feed && feed.hasMore ? feed.nextOffset : null,
    attribution: attributionFor(),
    ...(feed && feed.view === 'nearby' ? { near: feed.near, radiusKm: feed.radiusKm } : {}),
  };
}

module.exports = {
  attributionFor,
  projectSearchResult,
  projectSearchResponse,
  projectStep,
  projectLeg,
  projectRoute,
  projectRoutingResponse,
  projectPlace,
  projectPlacesResponse,
  projectPlaceResponse,
  projectProposal,
  projectProposalFeed,
  projectReport,
  projectReportFeed,
};
