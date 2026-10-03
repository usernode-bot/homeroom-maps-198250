// Offline search staging demo seed (Phase 12B).
//
// Phase 12A's B2 tile-provider download gate is closed, so no real region can
// be downloaded on staging. This module seeds ONE synthetic region plus the
// committed fixture tile into the device-local IndexedDB store so the changed
// UI (offline results, the Offline badge, the scope line) is reachable on a
// staging preview and in before/after shots.
//
// It obeys the platform staging-mock-data rules exactly:
//   - it runs ONLY when USERNODE_ENV is staging AND the caller passed the
//     `?demo=1` flag; on any other environment or without the flag it is a
//     no-op and the same route renders the normal screen,
//   - it is idempotent (fixed ids, ON CONFLICT-style overwrite),
//   - every name is obviously fake ("Staging demo ..."),
//   - it writes only device-local data (IndexedDB), never the database, and
//     never attributes anything to the visitor's identity,
//   - the eligibility check downstream reads the real `status`/`artifacts`
//     fields, which the seed legitimately sets, and the plain unseeded route
//     is also declared so the production-shaped empty state is asserted.
import { createTileStore } from './offline-tiles.js';

// The demo region id and the fixture's tile coordinate. The fixture carries a
// `place` layer whose four features all fall inside this one tile.
export const DEMO_REGION_ID = 'staging-demo-offline-search';
export const DEMO_TILE = { z: 12, x: 3263, y: 2118 };
export const DEMO_FIXTURE_URL = '/tests/fixtures/offline-search-place.mvt';

// A small rectangle around the fixture coordinates, a narrow zoom range, and
// the same attribution a real region would carry.
export const DEMO_REGION = {
  version: 1,
  id: DEMO_REGION_ID,
  name: 'Staging demo area',
  provider: 'maplibre-openfreemap',
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  attribution: 'OpenFreeMap, OpenMapTiles, OpenStreetMap',
  bounds: { west: 106.75, south: -6.25, east: 106.9, north: -6.1 },
  zoom: { min: 12, max: 12 },
  artifacts: [
    { kind: 'tiles', format: 'mvt', status: 'complete', tileCount: 1, byteSize: 324 },
  ],
  status: 'complete',
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:00.000Z',
};

// True when the seed flag is set AND this is staging. The env check is the
// platform rule (staging-only mock data); the `seed=1` flag is the
// request-time demo injection the conventions sanction. `offline=1` alone
// forces the offline path WITHOUT seeding, so a plain route asserts the
// production-shaped "no offline areas" empty state.
export function shouldSeedOfflineSearchDemo({ seed, environment } = {}) {
  return seed === true && environment === 'staging';
}

// Fetch the committed fixture and store it as the demo region's one tile.
// `fetchImpl` is injectable for tests; a Fetch that returns a non-OK response
// or a Worker/IDB failure throws, and the caller swallows it (the seed is
// best-effort and never breaks boot). The fetch is retried a couple of times
// because boot under load can lose a single request; a region with a manifest
// but no tile would otherwise look complete and search empty.
export async function seedOfflineSearchDemo({
  store,
  fetchImpl = null,
  fixtureUrl = DEMO_FIXTURE_URL,
  region = DEMO_REGION,
  attempts = 3,
  retryDelayMs = 250,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const tileStore = store || createTileStore({});
  await tileStore.putRegion({ ...region, artifacts: region.artifacts.map((a) => ({ ...a })) });

  let lastError = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      const res = await doFetch(fixtureUrl, { cache: 'no-store' });
      if (!res || !res.ok) throw new Error(`Demo fixture fetch failed (${res && res.status})`);
      const data = await res.arrayBuffer();
      await tileStore.putTile({
        regionId: region.id,
        z: DEMO_TILE.z,
        x: DEMO_TILE.x,
        y: DEMO_TILE.y,
        data,
      });
      return region;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Demo fixture fetch failed');
}
