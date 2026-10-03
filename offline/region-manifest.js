// RegionManifest v1 — the frozen contract for an offline map region.
//
// A region manifest is the record both the server and the browser agree on:
// which provider the region came from, the rectangular bounds and zoom range
// it covers, the style URL the tiles belong to, and the artifacts that make
// it renderable offline. Phase 12A creates `tiles` artifacts; Phase 12B will
// create `index` artifacts and Phase 12C `graph` artifacts under the same
// kinds. Nothing else about the shape may drift without a version bump: a
// manifest that does not validate here is never stored, so an interrupted or
// malformed download can never present itself as a completed region.
//
// Every entry point returns `{ ok, manifest | errors }` — never throws — so
// callers (server resolver now, download orchestration client-side) can
// surface a typed failure instead of a stack trace.
'use strict';

const MANIFEST_VERSION = 1;

// The artifact kinds the v1 contract defines. `tiles` is Phase 12A's map
// region; `index` and `graph` belong to the offline search and offline
// routing streams and are accepted here so the contract already covers them.
const ARTIFACT_KINDS = ['tiles', 'index', 'graph'];

const ARTIFACT_STATUSES = ['pending', 'complete', 'failed'];

const REGION_STATUSES = ['downloading', 'complete', 'interrupted', 'failed'];

// Web-mercator latitude limits (the same bounds tile x/y math is valid over).
const MAX_LAT = 85.05112878;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateBounds(bounds) {
  const errors = [];
  if (!bounds || typeof bounds !== 'object') {
    return { ok: false, errors: ['bounds must be an object'] };
  }
  const { west, south, east, north } = bounds;
  for (const [key, value] of Object.entries({ west, south, east, north })) {
    if (!isFiniteNumber(value)) errors.push(`bounds.${key} must be a finite number`);
  }
  if (errors.length) return { ok: false, errors };
  if (west < -180 || west > 180) errors.push('bounds.west must be within [-180, 180]');
  if (east < -180 || east > 180) errors.push('bounds.east must be within [-180, 180]');
  if (south < -MAX_LAT || south > MAX_LAT) {
    errors.push(`bounds.south must be within [-${MAX_LAT}, ${MAX_LAT}]`);
  }
  if (north < -MAX_LAT || north > MAX_LAT) {
    errors.push(`bounds.north must be within [-${MAX_LAT}, ${MAX_LAT}]`);
  }
  if (west >= east) errors.push('bounds.west must be less than bounds.east');
  if (south >= north) errors.push('bounds.south must be less than bounds.north');
  return errors.length ? { ok: false, errors } : { ok: true, value: { west, south, east, north } };
}

function validateZoom(zoom) {
  if (!zoom || typeof zoom !== 'object') {
    return { ok: false, errors: ['zoom must be an object'] };
  }
  const errors = [];
  const { min, max } = zoom;
  for (const [key, value] of Object.entries({ min, max })) {
    if (!Number.isInteger(value) || value < 0 || value > 22) {
      errors.push(`zoom.${key} must be an integer within [0, 22]`);
    }
  }
  if (!errors.length && min > max) errors.push('zoom.min must be less than or equal to zoom.max');
  return errors.length ? { ok: false, errors } : { ok: true, value: { min, max } };
}

// One artifact entry. `tiles` artifacts additionally carry the expected tile
// count once the plan is computed; verification compares the stored count
// against exactly this number, so a partial download can never validate.
function validateArtifact(artifact, index) {
  const where = `artifacts[${index}]`;
  const errors = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, errors: [`${where} must be an object`] };
  }
  if (!ARTIFACT_KINDS.includes(artifact.kind)) {
    errors.push(`${where}.kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
  }
  if (typeof artifact.format !== 'string' || !artifact.format.trim()) {
    errors.push(`${where}.format must be a non-empty string`);
  }
  if (artifact.status && !ARTIFACT_STATUSES.includes(artifact.status)) {
    errors.push(`${where}.status must be one of ${ARTIFACT_STATUSES.join(', ')}`);
  }
  if (artifact.tileCount !== undefined) {
    if (!Number.isInteger(artifact.tileCount) || artifact.tileCount < 0) {
      errors.push(`${where}.tileCount must be a non-negative integer when present`);
    }
  }
  if (artifact.byteSize !== undefined) {
    if (!isFiniteNumber(artifact.byteSize) || artifact.byteSize < 0) {
      errors.push(`${where}.byteSize must be a non-negative number when present`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: artifact };
}

function validateRegionManifest(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  if (input.version !== MANIFEST_VERSION) {
    errors.push(`version must be ${MANIFEST_VERSION}`);
  }
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(input.id)) {
    errors.push('id must be 1-64 characters of [A-Za-z0-9-]');
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) {
    errors.push('name must be a non-empty string of at most 80 characters');
  }
  if (typeof input.provider !== 'string' || !input.provider.trim()) {
    errors.push('provider must be a non-empty string');
  }
  if (typeof input.styleUrl !== 'string' || !/^https:\/\//.test(input.styleUrl)) {
    errors.push('styleUrl must be an https URL');
  }
  if (typeof input.attribution !== 'string' || !input.attribution.trim()) {
    errors.push('attribution must be a non-empty string');
  }

  const bounds = validateBounds(input.bounds);
  if (!bounds.ok) errors.push(...bounds.errors);
  const zoom = validateZoom(input.zoom);
  if (!zoom.ok) errors.push(...zoom.errors);

  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    errors.push('artifacts must be a non-empty array');
  } else {
    const artifacts = [];
    input.artifacts.forEach((artifact, index) => {
      const check = validateArtifact(artifact, index);
      if (check.ok) artifacts.push(check.value);
      else errors.push(...check.errors);
    });
    // A map region must plan at least one tiles artifact; index and graph
    // artifacts may be added by their own streams on top of it.
    if (!errors.length && !artifacts.some((a) => a.kind === 'tiles')) {
      errors.push('artifacts must include at least one "tiles" artifact');
    }
  }

  if (input.status && !REGION_STATUSES.includes(input.status)) {
    errors.push(`status must be one of ${REGION_STATUSES.join(', ')}`);
  }
  if (input.createdAt !== undefined && Number.isNaN(Date.parse(input.createdAt))) {
    errors.push('createdAt must be an ISO date string when present');
  }
  if (input.completedAt !== undefined && Number.isNaN(Date.parse(input.completedAt))) {
    errors.push('completedAt must be an ISO date string when present');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      id: input.id,
      name: input.name.trim(),
      provider: input.provider.trim(),
      styleUrl: input.styleUrl,
      attribution: input.attribution.trim(),
      bounds: bounds.value,
      zoom: zoom.value,
      artifacts: input.artifacts.map((a) => ({ ...a })),
      status: input.status || 'downloading',
      createdAt: input.createdAt || new Date().toISOString(),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    },
  };
}

// Slippy-map tile coordinate helpers, used by both the preset estimator
// (server) and the download planner (client) so the tile count in a manifest
// is computed by exactly one implementation.
function longitudeToTileX(lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  // Clamp into the valid tile range: the antimeridian edge (lng 180) and
  // rounding at the projection limits must never yield an out-of-range tile.
  return Math.min(Math.max(x, 0), n - 1);
}

function latitudeToTileY(lat, zoom) {
  const n = Math.pow(2, zoom);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  // The Web Mercator latitude limit (85.05112878 when rounded for display)
  // lands a hair past the projection edge and floors to -1: clamp to row 0.
  return Math.min(Math.max(y, 0), n - 1);
}

// Count of z/x/y tiles covering a bounds at one zoom level, clamped to the
// valid tile range. Used to plan and estimate a region before downloading.
function tileCountForBounds(bounds, zoom) {
  const n = Math.pow(2, zoom);
  const xMin = Math.min(Math.max(longitudeToTileX(bounds.west, zoom), 0), n - 1);
  const xMax = Math.min(Math.max(longitudeToTileX(bounds.east, zoom), 0), n - 1);
  const yMin = Math.min(Math.max(latitudeToTileY(bounds.north, zoom), 0), n - 1);
  const yMax = Math.min(Math.max(latitudeToTileY(bounds.south, zoom), 0), n - 1);
  return (xMax - xMin + 1) * (yMax - yMin + 1);
}

module.exports = {
  MANIFEST_VERSION,
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  REGION_STATUSES,
  MAX_LAT,
  validateRegionManifest,
  validateBounds,
  validateZoom,
  longitudeToTileX,
  latitudeToTileY,
  tileCountForBounds,
};