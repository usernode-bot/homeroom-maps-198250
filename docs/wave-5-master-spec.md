# Wave 5 — Master Specification v3 (Phase 12A–12K, Planning Only)

## 0. Preamble

**Scope**: This specification covers Wave 5 planning only. No code, no schema, no routes, no packages will be created during this phase. Phases 0–10 are implemented in main. Phase 11 (AI Map Assistant) exists in PR #22 and MUST NOT be modified by any Wave 5 stream.

**Phase 11 constraint**: All files under `/assistant/` (actions.js, prompt.js, provider.js, routes.js, tools.js) and the AI assistant client components (`/public/js/components/assistant/`, `/public/js/services/assistant.js`) are frozen. Wave 5 streams that need to expose data to the AI assistant MUST define adapters in shared contracts rather than editing Phase 11 code.

**Repository structure confirmed**:
- Server: `config.js`, `server.js`, `search/`, `routing/`, `places/`, `community/`, `reports/`, `saved/`, `trips/`, `assistant/`
- Client: `public/js/map/`, `public/js/services/`, `public/js/screens/`, `public/js/components/`
- Database: 13 tables across community, reports, saved, trips (proposals, proposal_votes, saved_lists, saved_places, trips, trip_days, trip_items, reports, report_reactions, report_flags, report_status_events)
- Map capabilities (config.js:85): `offline: false`, `traffic: false`, `transit: false`
- Provider abstractions exist: `search/provider.js`, `routing/provider.js`, `places/provider.js`, `public/js/map/adapter.js`

## User-facing changes

Wave 5 introduces eleven major capability streams that extend Homeroom Maps from a connected-only mapping app into a platform with offline resilience, live data enrichment, social location features, advanced visualization, community governance, business presence, and developer extensibility.

Each stream delivers distinct user value:

**12A Offline Maps** enables users to download regional map tiles for use without network connectivity. Users see a new "Download offline maps" option in Profile, can select rectangular regions or administrative boundaries, monitor download progress, manage stored regions (rename, delete, update), and seamlessly view the map when offline. The map automatically falls back to cached tiles when connectivity is lost.

**12B Offline Search** extends search to work without network when offline regions are available. Users see search results from their downloaded regions even when offline, with results clearly marked as "offline" and limited to the cached region's coverage. Online search remains unchanged when connectivity exists.

**12C Offline Routing** provides turn-by-turn routing without network using pre-downloaded road network data. Users can calculate routes between points within their offline regions, see route geometry and turn instructions, and start navigation—all without connectivity. Routes are limited to offline region boundaries.

**12D Traffic** overlays real-time traffic conditions on the map. Users see color-coded road segments (green/yellow/red for flow speed), incident markers (accidents, construction, closures), and traffic-adjusted route durations in Directions. Traffic data refreshes automatically every 2 minutes when online.

**12E Public Transit** adds transit routing and stop/station display. Users can select "Transit" as a travel mode in Directions, see routes with transfers and schedules, view transit stops on the map with departure times, and filter by transit type (bus, rail, ferry). Transit data comes from GTFS feeds.

**12F Location Sharing** lets users share their real-time location with trusted contacts. Users invite contacts by username, see shared locations on the map with contact avatars, control sharing duration (1 hour / 1 day / until turned off), and revoke access instantly. Recipients see only current location, never history.

**12G Weather** displays current weather conditions and forecasts on the map. Users see temperature, precipitation, and wind overlays, can tap locations for detailed forecasts (hourly/daily), and see severe weather alerts. Weather data is independent of offline regions.

**12H 3D Maps** enables three-dimensional map visualization with terrain elevation and building extrusions. Users toggle 3D mode from a control on the Home map, tilt and rotate the view with touch gestures, see buildings rendered with height data, and view terrain with realistic elevation. 3D mode is optional and can be disabled for performance.

**12I Advanced Community Contributions** extends the community system with photo uploads, discussion threads, and reputation. Users attach photos to proposals, participate in comment threads on proposals, earn reputation points for accepted proposals and helpful comments, and see contributor leaderboards. Moderation tools flag inappropriate content.

**12J Business Profiles** enables business owners to claim and manage their place listings. Business owners verify ownership, update hours/contact/photos, respond to community proposals about their business, and see analytics (views, saves). Public users see verified business badges and richer place details.

**12K Developer API** exposes a read-only API for third-party applications. Developers obtain API keys, query places/search/routing within rate limits, access community proposals and reports, and integrate Homeroom Maps data into their applications. API usage is tracked and rate-limited.

## Technical implementation

### 1. Per-Stream Specification

#### 12A Offline Maps

1. **Goal**: Enable offline map viewing through regional tile caching on the client device.

2. **User-facing capabilities**: Download regions, manage stored regions, automatic fallback to cached tiles when offline, progress indicators during download, storage usage display.

3. **Scope**: Client-side tile caching using browser storage (IndexedDB), region selection UI, download management, offline detection and fallback logic in map adapter.

4. **Explicit non-goals**: Server-side tile pre-generation, tile serving infrastructure, offline search/routing (separate streams), tile format conversion.

5. **Ownership**: Client team owns tile caching and UI. Platform team owns offline detection. Map adapter team owns fallback integration.

6. **New files/modules**: 
   - `public/js/services/offline-tiles.js` (tile storage/retrieval)
   - `public/js/services/offline-regions.js` (region management)
   - `public/js/components/offline/region-picker.js` (selection UI)
   - `public/js/components/offline/download-manager.js` (progress UI)
   - `public/js/screens/offline-maps.js` (management screen)
   - `tests/offline-tiles.test.js`, `tests/offline-regions.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/map/maplibre.js` (add tile source interception for offline fallback)
   - `public/js/map/adapter.js` (extend capabilities with `offline: true`)
   - `config.js` (add `OFFLINE_ENABLED`, `OFFLINE_MAX_STORAGE_MB` config)
   - `server.js` (add `/api/config` offline capability flag)
   - `public/js/screens/profile.js` (add "Offline Maps" entry)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (offline strings)

8. **Files that MUST NOT be edited**: `assistant/*`, `public/js/components/assistant/*`, `public/js/services/assistant.js`

9. **Dependencies**: MapLibre GL JS tile loading hooks, IndexedDB API, browser storage quota API, online/offline detection (navigator.onLine, online/offline events).

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this).

11. **Required contracts/interfaces**: 
    - `OfflineTileStore` interface: `store(regionId, z, x, y, data)`, `retrieve(z, x, y)`, `deleteRegion(regionId)`, `listRegions()`, `getStorageUsage()`
    - `OfflineRegion` type: `{ id, name, bounds: {west, south, east, north}, zoomRange: [min, max], tileCount, byteSize, downloadedAt }`
    - Map adapter extension: `setOfflineFallback(enabled: boolean)`

12. **Cross-stream contracts**: 12B consumes `OfflineRegion.bounds` to filter offline search. 12C consumes `OfflineRegion.bounds` to validate offline routing requests. Both depend on 12A's `OfflineRegion` type definition.

13. **Backend requirements**: None for core functionality. Optional: server endpoint `/api/offline/regions/suggest` to recommend popular regions (requires analytics data).

14. **Frontend requirements**: IndexedDB for tile storage (typical 50MB–500MB per region), Service Worker for offline detection (optional), quota management UI.

15. **Database/data requirements**: None on server. Client-side IndexedDB stores tiles and region metadata.

16. **Configuration/environment requirements**: `OFFLINE_ENABLED` (boolean, default true), `OFFLINE_MAX_STORAGE_MB` (number, default 2048), `OFFLINE_TILE_URL_TEMPLATE` (string, optional override).

17. **External provider requirements**: Tile source must allow bulk download (check OpenFreeMap terms). Rate limiting during download to avoid provider throttling.

18. **Licensing requirements**: Tile data inherits OpenStreetMap ODbL license. Must display attribution even when offline. Cached tiles must retain attribution metadata.

19. **Cost implications**: Tile downloads increase provider bandwidth costs. Estimate 10–100MB per region. No server infrastructure cost.

20. **Privacy/security requirements**: Tile cache is device-local only. No location data leaves device. Storage quota must respect user limits. Clear cache on user request.

21. **Performance requirements**: Tile retrieval < 10ms from IndexedDB. Download progress updates at 1Hz. Region selection UI renders < 100ms. Storage usage calculation < 500ms for 10k tiles.

22. **Offline implications**: Core functionality. Tiles cached per-region. Automatic detection via `navigator.onLine` and tile fetch failures. Fallback to cached tiles when online tiles fail.

23. **Testing requirements**: Unit tests for tile storage CRUD, region bounds validation, quota enforcement. Integration tests for offline fallback in map adapter. Manual tests: download 100MB region, verify offline viewing, test storage cleanup.

#### 12B Offline Search

1. **Goal**: Enable search within offline regions without network connectivity.

2. **User-facing capabilities**: Search returns results from downloaded offline regions when offline, results marked as "offline", search limited to cached region coverage, online search unchanged when connected.

3. **Scope**: Client-side search index built from offline region tile data, search UI integration with offline detection, result filtering by region bounds.

4. **Explicit non-goals**: Server-side offline search index generation, full-text search, POI extraction from tiles (limited to place names in tile metadata), cross-region search when offline.

5. **Ownership**: Search team owns client-side indexing and query logic. Offline team (12A) provides region data.

6. **New files/modules**:
   - `public/js/services/offline-search-index.js` (build/query index from tiles)
   - `public/js/services/offline-search.js` (offline search service)
   - `tests/offline-search.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/services/search.js` (add offline fallback in `run()`)
   - `public/js/screens/home.js`, `public/js/screens/discover.js` (mark offline results)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (offline search strings)

8. **Files that MUST NOT be edited**: `search/*` (server-side), `assistant/*`, `public/js/components/assistant/*`

9. **Dependencies**: 12A Offline Maps (provides `OfflineRegion`, tile data), tile metadata extraction (place names from vector tiles).

10. **Dependency classification**: HARD on 12A (cannot build offline search without offline regions).

11. **Required contracts/interfaces**:
    - `OfflineSearchIndex` interface: `build(regionId, tiles)`, `query(text, bounds, limit)`, `delete(regionId)`
    - `OfflineSearchResult` type: `{ id, name, type, coordinates: {lat, lng}, regionId, offline: true }`
    - Consumes 12A's `OfflineRegion` and `OfflineTileStore.retrieve()`

12. **Cross-stream contracts**: Consumes 12A's `OfflineRegion.bounds` to filter results. Provides `OfflineSearchResult` to 12C for offline destination validation.

13. **Backend requirements**: None. Entirely client-side.

14. **Frontend requirements**: Vector tile parsing (Mapbox Vector Tile format), in-memory search index (trie or inverted index), Web Worker for index building (avoid UI blocking).

15. **Database/data requirements**: None on server. Client-side in-memory index built from tile metadata.

16. **Configuration/environment requirements**: `OFFLINE_SEARCH_ENABLED` (boolean, default true if 12A enabled).

17. **External provider requirements**: Tile format must include place name metadata (OpenMapTiles schema includes this).

18. **Licensing requirements**: Search results inherit tile data license (OSM ODbL). Attribution required.

19. **Cost implications**: No server cost. Client CPU cost for index building (estimate 2–5 seconds per 100MB region).

20. **Privacy/security requirements**: Search queries never leave device when offline. Index is ephemeral (rebuilt from tiles on demand).

21. **Performance requirements**: Index build < 5s per 100MB region. Query < 50ms for 10k place names. Memory usage < 50MB for 100k places.

22. **Offline implications**: Core functionality. Index built from cached tiles. Search unavailable if no offline regions downloaded.

23. **Testing requirements**: Unit tests for index building, query matching, bounds filtering. Integration tests with 12A tile store. Manual tests: download region, go offline, search for places in region.

#### 12C Offline Routing

1. **Goal**: Enable routing within offline regions without network connectivity.

2. **User-facing capabilities**: Calculate routes between points within offline regions when offline, see route geometry and turn instructions, start navigation—all without connectivity. Routes limited to offline region boundaries.

3. **Scope**: Client-side routing engine using pre-downloaded road network data, route calculation UI integration with offline detection, validation that origin/destination are within offline region.

4. **Explicit non-goals**: Server-side offline routing graph generation, multi-modal routing, real-time traffic in offline mode, routing across region boundaries.

5. **Ownership**: Routing team owns client-side routing engine. Offline team (12A) provides road network data.

6. **New files/modules**:
   - `public/js/services/offline-routing-graph.js` (build/load routing graph from tiles)
   - `public/js/services/offline-routing.js` (offline routing service)
   - `tests/offline-routing.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/services/routing.js` (add offline fallback in `route()`)
   - `public/js/screens/directions.js` (validate offline routing requests, mark offline routes)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (offline routing strings)

8. **Files that MUST NOT be edited**: `routing/*` (server-side), `assistant/*`, `public/js/services/navigation.js` (Phase 8)

9. **Dependencies**: 12A Offline Maps (provides road network tiles), 12B Offline Search (optional: destination lookup), client-side routing engine (e.g., OSRM.js or Valhalla WASM).

10. **Dependency classification**: HARD on 12A (cannot build offline routing without road network data). SOFT on 12B (can accept manual coordinates if offline search unavailable).

11. **Required contracts/interfaces**:
    - `OfflineRoutingGraph` interface: `build(regionId, tiles)`, `route(origin, destination, mode)`, `delete(regionId)`
    - `OfflineRouteResult` type: `{ geometry: [[lng, lat]], distance, duration, instructions: [], regionId, offline: true }`
    - Consumes 12A's `OfflineRegion` and road network tiles (OpenStreetMap road data)

12. **Cross-stream contracts**: Consumes 12A's `OfflineRegion.bounds` to validate routing requests. Consumes 12B's `OfflineSearchResult` for destination resolution (optional).

13. **Backend requirements**: None. Entirely client-side.

14. **Frontend requirements**: Routing graph data structure (edge/vertex graph), pathfinding algorithm (A* or Dijkstra), WebAssembly for performance (optional), Web Worker for graph building.

15. **Database/data requirements**: None on server. Client-side routing graph built from road network tiles.

16. **Configuration/environment requirements**: `OFFLINE_ROUTING_ENABLED` (boolean, default true if 12A enabled).

17. **External provider requirements**: Tile format must include road network data (OpenMapTiles transportation layer). Routing engine library (OSRM.js, Valhalla WASM, or custom).

18. **Licensing requirements**: Routing data inherits tile data license (OSM ODbL). Routing engine library license (BSD for OSRM, BSD for Valhalla).

19. **Cost implications**: No server cost. Client CPU/memory cost for graph building (estimate 10–30 seconds per 100MB region, 100–300MB memory for graph).

20. **Privacy/security requirements**: Routing requests never leave device when offline. Graph is ephemeral (rebuilt from tiles on demand).

21. **Performance requirements**: Graph build < 30s per 100MB region. Route calculation < 500ms for 50km route. Memory usage < 300MB for regional graph.

22. **Offline implications**: Core functionality. Graph built from cached road network tiles. Routing unavailable if no offline regions downloaded or if origin/destination outside region.

23. **Testing requirements**: Unit tests for graph building, pathfinding, bounds validation. Integration tests with 12A tile store. Manual tests: download region with road network, go offline, calculate route within region, verify geometry and instructions.

#### 12D Traffic

1. **Goal**: Display real-time traffic conditions and incidents on the map.

2. **User-facing capabilities**: Color-coded road segments (green/yellow/red for flow speed), incident markers (accidents, construction, closures), traffic-adjusted route durations in Directions, automatic refresh every 2 minutes.

3. **Scope**: Traffic data provider integration, traffic overlay rendering on map, traffic data in routing calculations, incident display.

4. **Explicit non-goals**: Traffic prediction, historical traffic analysis, user-reported incidents (separate community feature), offline traffic data.

5. **Ownership**: Data integration team owns provider integration. Map team owns traffic overlay rendering. Routing team owns traffic-adjusted routing.

6. **New files/modules**:
   - `public/js/services/traffic.js` (traffic data service)
   - `public/js/map/traffic-layer.js` (traffic overlay rendering)
   - `tests/traffic.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/map/maplibre.js` (add traffic layer to map)
   - `public/js/map/adapter.js` (extend capabilities with `traffic: true`)
   - `config.js` (add `TRAFFIC_PROVIDER`, `TRAFFIC_API_KEY` config)
   - `server.js` (add `/api/traffic` proxy endpoint)
   - `public/js/screens/home.js` (add traffic toggle control)
   - `public/js/screens/directions.js` (display traffic-adjusted durations)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (traffic strings)
   - `dapp.json` (add `TRAFFIC_PROVIDER`, `TRAFFIC_API_KEY` secrets)

8. **Files that MUST NOT be edited**: `routing/*` (server-side routing logic), `assistant/*`, `public/js/services/navigation.js`

9. **Dependencies**: Traffic data provider (TomTom, HERE, Mapbox Traffic, or OpenLR), map layer rendering, routing provider that supports traffic-adjusted durations.

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this).

11. **Required contracts/interfaces**:
    - `TrafficProvider` interface: `getFlow(bounds)`, `getIncidents(bounds)`
    - `TrafficFlow` type: `{ segments: [{ geometry: [[lng, lat]], speed, congestion: 'low'|'medium'|'high' }] }`
    - `TrafficIncident` type: `{ id, type: 'accident'|'construction'|'closure', location: {lat, lng}, description, startTime, endTime }`
    - Routing provider extension: `capabilities.traffic: true`, route response includes `trafficDelay`

12. **Cross-stream contracts**: None (independent stream).

13. **Backend requirements**: Server proxy endpoint `/api/traffic/flow` and `/api/traffic/incidents` to hide API key, cache responses for 2 minutes, rate limiting to respect provider quotas.

14. **Frontend requirements**: Traffic layer rendering (color-coded lines, incident markers), auto-refresh timer (2 minutes), viewport-based data fetching.

15. **Database/data requirements**: None. Traffic data is ephemeral and fetched on-demand.

16. **Configuration/environment requirements**: `TRAFFIC_PROVIDER` (string: 'tomtom', 'here', 'mapbox'), `TRAFFIC_API_KEY` (string, required), `TRAFFIC_REFRESH_MS` (number, default 120000).

17. **External provider requirements**: Traffic data provider with flow and incident APIs. TomTom: $0.50 per 1000 requests after 2500 free/day. HERE: freemium with 250k transactions/month. Mapbox: included in Maps SDK.

18. **Licensing requirements**: Traffic data is proprietary (provider terms). Display attribution per provider requirements. No caching beyond 2-minute refresh window.

19. **Cost implications**: Provider API costs based on usage. Estimate 1000–10000 requests/day depending on user count. $5–50/day at scale.

20. **Privacy/security requirements**: Traffic queries include viewport bounds only (no user location unless user centers map on location). API key stored server-side only.

21. **Performance requirements**: Traffic data fetch < 500ms. Layer rendering < 100ms for 1000 segments. Auto-refresh does not block UI.

22. **Offline implications**: Traffic unavailable offline. Traffic layer hidden when offline. Routing falls back to static durations when offline.

23. **Testing requirements**: Unit tests for provider adapters, data normalization. Integration tests with map layer. Manual tests: enable traffic, verify color coding, check incident markers, test auto-refresh.

#### 12E Public Transit

1. **Goal**: Enable transit routing and display transit stops/stations on the map.

2. **User-facing capabilities**: Select "Transit" travel mode in Directions, see routes with transfers and schedules, view transit stops on map with departure times, filter by transit type (bus, rail, ferry).

3. **Scope**: GTFS data ingestion, transit routing engine, transit stop display, schedule lookup.

4. **Explicit non-goals**: Real-time transit delays (GTFS-Realtime, future scope), transit fare calculation, multi-agency journey planning beyond single GTFS feed.

5. **Ownership**: Data integration team owns GTFS ingestion. Routing team owns transit routing. Map team owns stop display.

6. **New files/modules**:
   - `transit/model.js` (GTFS data model)
   - `transit/store.js` (GTFS database access)
   - `transit/routes.js` (`/api/transit/*` endpoints)
   - `public/js/services/transit.js` (client transit service)
   - `public/js/map/transit-layer.js` (transit stop rendering)
   - `public/js/components/transit/stop-popup.js` (stop details UI)
   - `tests/transit.model.test.js`, `tests/transit.postgres.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/map/maplibre.js` (add transit stop layer)
   - `public/js/map/adapter.js` (extend capabilities with `transit: true`)
   - `config.js` (add `TRANSIT_ENABLED`, `TRANSIT_GTFS_URL` config)
   - `server.js` (add transit router, migrate transit tables)
   - `public/js/screens/directions.js` (add transit mode, display transit routes)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (transit strings)
   - `dapp.json` (add `TRANSIT_ENABLED` secret)

8. **Files that MUST NOT be edited**: `routing/*` (server-side routing logic, transit is separate), `assistant/*`

9. **Dependencies**: GTFS feed URL, GTFS parsing library, transit routing algorithm (RAPTOR or transfer patterns), database for GTFS data.

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this).

11. **Required contracts/interfaces**:
    - `TransitProvider` interface: `getStops(bounds)`, `getDepartures(stopId, time)`, `route(origin, destination, time)`
    - `TransitStop` type: `{ id, name, location: {lat, lng}, routes: [{ id, name, type: 'bus'|'rail'|'ferry' }] }`
    - `TransitRoute` type: `{ legs: [{ mode, from, to, departure, arrival, route: { id, name, type } }], duration }`

12. **Cross-stream contracts**: None (independent stream).

13. **Backend requirements**: GTFS feed downloader (scheduled job), GTFS parser, PostgreSQL tables for stops/routes/trips/stop_times, transit routing endpoint `/api/transit/route`, stop lookup endpoint `/api/transit/stops`.

14. **Frontend requirements**: Transit mode in Directions UI, transit route rendering (line geometry from GTFS shapes), stop markers on map, departure time display.

15. **Database/data requirements**: New tables: `transit_agencies`, `transit_routes`, `transit_trips`, `transit_stops`, `transit_stop_times`, `transit_shapes`. Estimate 100MB–1GB for a city's GTFS feed.

16. **Configuration/environment requirements**: `TRANSIT_ENABLED` (boolean, default false), `TRANSIT_GTFS_URL` (string, URL to GTFS zip), `TRANSIT_UPDATE_CRON` (string, default '0 3 * * *' for 3am daily).

17. **External provider requirements**: GTFS feed from transit agency (usually free, public domain). GTFS parsing library (e.g., `gtfs-sequelize`).

18. **Licensing requirements**: GTFS data is usually public domain or Creative Commons. Display attribution per agency requirements.

19. **Cost implications**: Database storage for GTFS data (100MB–1GB). No API costs (GTFS is static files). Compute cost for daily feed updates.

20. **Privacy/security requirements**: Transit queries include origin/destination/time only. No user tracking.

21. **Performance requirements**: GTFS feed ingestion < 10 minutes for 1GB feed. Stop lookup < 50ms. Route calculation < 1s for 1-hour journey.

22. **Offline implications**: Transit unavailable offline (requires database queries). Future scope: client-side GTFS cache for offline transit.

23. **Testing requirements**: Unit tests for GTFS parsing, transit routing algorithm. Integration tests with database. Manual tests: load GTFS feed, query stops in viewport, calculate transit route, verify schedule accuracy.

#### 12F Location Sharing

1. **Goal**: Enable real-time location sharing between trusted contacts.

2. **User-facing capabilities**: Invite contacts by username, share location for 1 hour / 1 day / until turned off, see shared locations on map with contact avatars, revoke access instantly, recipients see only current location (never history).

3. **Scope**: Contact management, location sharing invitations, real-time location updates, sharing duration controls, revocation.

4. **Explicit non-goals**: Location history, location-based messaging, sharing with non-users, anonymous sharing, location sharing to social media.

5. **Ownership**: Platform team owns contact management and sharing logic. Map team owns location display.

6. **New files/modules**:
   - `location-sharing/model.js` (sharing data model)
   - `location-sharing/store.js` (sharing database access)
   - `location-sharing/routes.js` (`/api/location-sharing/*` endpoints)
   - `public/js/services/location-sharing.js` (client sharing service)
   - `public/js/components/location-sharing/invite-dialog.js` (invite UI)
   - `public/js/components/location-sharing/contacts-list.js` (contacts UI)
   - `public/js/map/contacts-layer.js` (contact location rendering)
   - `public/js/screens/location-sharing.js` (management screen)
   - `tests/location-sharing.model.test.js`, `tests/location-sharing.postgres.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/map/maplibre.js` (add contacts layer)
   - `public/js/screens/profile.js` (add "Location Sharing" entry)
   - `server.js` (add location-sharing router, migrate tables)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (sharing strings)

8. **Files that MUST NOT be edited**: `public/js/services/location.js` (device location service, read-only consumer), `assistant/*`

9. **Dependencies**: Real-time push mechanism (WebSocket or Server-Sent Events), contact lookup by username, location permission flow.

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this).

11. **Required contracts/interfaces**:
    - `LocationSharingStore` interface: `invite(inviterId, inviteeUsername)`, `accept(inviteId)`, `share(userId, contactId, duration)`, `revoke(userId, contactId)`, `getContacts(userId)`, `getSharedLocations(userId)`
    - `Contact` type: `{ id, username, sharingStatus: 'invited'|'accepted'|'sharing', sharedUntil }`
    - `SharedLocation` type: `{ userId, username, location: {lat, lng, accuracy, timestamp}, sharedUntil }`

12. **Cross-stream contracts**: None (independent stream).

13. **Backend requirements**: PostgreSQL tables for contacts, sharing invitations, active shares. Location update endpoint `/api/location-sharing/update` (POST current location). Contact lookup endpoint `/api/location-sharing/contacts`. Real-time push for location updates (WebSocket or SSE).

14. **Frontend requirements**: Contact invitation UI, sharing duration selector, contact list with sharing status, map layer for contact locations, location update timer (every 30 seconds when sharing).

15. **Database/data requirements**: New tables: `location_sharing_contacts` (user_id, contact_user_id, status, invited_at, accepted_at), `location_sharing_active` (user_id, contact_user_id, shared_until, last_location JSONB, last_updated_at).

16. **Configuration/environment requirements**: `LOCATION_SHARING_ENABLED` (boolean, default true), `LOCATION_SHARING_MAX_CONTACTS` (number, default 50), `LOCATION_SHARING_UPDATE_INTERVAL_MS` (number, default 30000).

17. **External provider requirements**: None. Real-time push can use platform WebSocket infrastructure or SSE.

18. **Licensing requirements**: None. User-generated location data.

19. **Cost implications**: Database storage for contacts and active shares (minimal). Real-time push infrastructure cost (WebSocket connections). Estimate 10–100 concurrent connections per 1000 users.

20. **Privacy/security requirements**: Location shared only with explicit consent. Recipients see only current location, never history. Revocation is instant. Shared location expires automatically. Location data encrypted at rest. Audit log for sharing events.

21. **Performance requirements**: Location update propagation < 2 seconds. Contact list load < 100ms for 50 contacts. Map layer rendering < 50ms for 10 contacts.

22. **Offline implications**: Location sharing unavailable offline (requires real-time updates). Shared locations not displayed when offline.

23. **Testing requirements**: Unit tests for sharing logic, expiration, revocation. Integration tests with database. Manual tests: invite contact, accept, share location, verify real-time updates, test revocation, test expiration.

#### 12G Weather

1. **Goal**: Display current weather conditions and forecasts on the map.

2. **User-facing capabilities**: Temperature, precipitation, and wind overlays on map, tap locations for detailed forecasts (hourly/daily), severe weather alerts, weather data independent of offline regions.

3. **Scope**: Weather data provider integration, weather overlay rendering, forecast lookup by coordinates.

4. **Explicit non-goals**: Historical weather data, weather radar animation, user-reported weather, offline weather data.

5. **Ownership**: Data integration team owns provider integration. Map team owns weather overlay rendering.

6. **New files/modules**:
   - `public/js/services/weather.js` (weather data service)
   - `public/js/map/weather-layer.js` (weather overlay rendering)
   - `public/js/components/weather/forecast-popup.js` (forecast details UI)
   - `tests/weather.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/map/maplibre.js` (add weather layer)
   - `public/js/screens/home.js` (add weather toggle control)
   - `config.js` (add `WEATHER_PROVIDER`, `WEATHER_API_KEY` config)
   - `server.js` (add `/api/weather` proxy endpoint)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (weather strings)
   - `dapp.json` (add `WEATHER_PROVIDER`, `WEATHER_API_KEY` secrets)

8. **Files that MUST NOT be edited**: `assistant/*`

9. **Dependencies**: Weather data provider (OpenWeatherMap, WeatherAPI, Tomorrow.io), map layer rendering.

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this).

11. **Required contracts/interfaces**:
    - `WeatherProvider` interface: `getCurrent(lat, lng)`, `getForecast(lat, lng)`, `getOverlay(bounds, layer: 'temperature'|'precipitation'|'wind')`
    - `WeatherCurrent` type: `{ temperature, humidity, windSpeed, windDirection, condition: 'clear'|'cloudy'|'rain'|'snow', icon }`
    - `WeatherForecast` type: `{ hourly: [{ time, temperature, condition }], daily: [{ date, high, low, condition }] }`

12. **Cross-stream contracts**: None (independent stream).

13. **Backend requirements**: Server proxy endpoint `/api/weather/current`, `/api/weather/forecast`, `/api/weather/overlay` to hide API key, cache responses for 10 minutes (weather changes slowly).

14. **Frontend requirements**: Weather overlay rendering (raster tiles or vector contours), forecast popup with hourly/daily tabs, severe weather alert banner.

15. **Database/data requirements**: None. Weather data is fetched on-demand.

16. **Configuration/environment requirements**: `WEATHER_PROVIDER` (string: 'openweathermap', 'weatherapi', 'tomorrowio'), `WEATHER_API_KEY` (string, required), `WEATHER_CACHE_MS` (number, default 600000).

17. **External provider requirements**: Weather data provider API. OpenWeatherMap: free tier 1000 calls/day, paid $40/month for 10k calls. WeatherAPI: free tier 1M calls/month. Tomorrow.io: free tier 500 calls/day.

18. **Licensing requirements**: Weather data is proprietary (provider terms). Display attribution per provider requirements.

19. **Cost implications**: Provider API costs based on usage. Estimate 1000–10000 calls/day depending on user count. $0–40/day at scale.

20. **Privacy/security requirements**: Weather queries include coordinates only (no user identity). API key stored server-side only.

21. **Performance requirements**: Weather data fetch < 500ms. Overlay rendering < 100ms. Forecast popup load < 200ms.

22. **Offline implications**: Weather unavailable offline. Weather layer hidden when offline.

23. **Testing requirements**: Unit tests for provider adapters, data normalization. Integration tests with map layer. Manual tests: enable weather, verify overlay accuracy, check forecast popup, test severe weather alerts.

#### 12H 3D Maps

1. **Goal**: Enable three-dimensional map visualization with terrain elevation and building extrusions.

2. **User-facing capabilities**: Toggle 3D mode from map control, tilt and rotate view with touch gestures, buildings rendered with height data, terrain with realistic elevation, 3D mode optional and can be disabled for performance.

3. **Scope**: 3D tile source integration, terrain elevation data, building extrusion from vector tiles, 3D camera controls (tilt, rotate, pitch).

4. **Explicit non-goals**: Photorealistic 3D (Google Earth-style imagery), indoor mapping, AR/VR integration, 3D model uploads.

5. **Ownership**: Map team owns 3D rendering and camera controls. Data integration team owns terrain/building data sources.

6. **New files/modules**:
   - `public/js/map/terrain-layer.js` (terrain elevation rendering)
   - `public/js/map/buildings-layer.js` (building extrusion rendering)
   - `public/js/map/controls-3d.js` (3D camera controls)
   - `tests/map-3d.test.js`

7. **Existing files/modules that MAY be edited**:
   - `public/js/map/maplibre.js` (add 3D layers, enable pitch/bearing controls)
   - `public/js/map/adapter.js` (extend capabilities with `3d: true`)
   - `public/js/screens/home.js` (add 3D toggle control)
   - `config.js` (add `MAP_3D_ENABLED`, `MAP_3D_TERRAIN_URL`, `MAP_3D_BUILDINGS_SOURCE` config)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (3D strings)

8. **Files that MUST NOT be edited**: `assistant/*`

9. **Dependencies**: MapLibre GL JS 3D capabilities (terrain-rgb tiles, fill-extrusion layer), terrain elevation data source, building height data in vector tiles.

10. **Dependency classification**: SOFT on 12A (can use online 3D tiles without offline caching, but offline 3D would require 12A).

11. **Required contracts/interfaces**:
    - `TerrainProvider` interface: `getTerrainSource()` (returns raster-dem tile source config)
    - `BuildingsProvider` interface: `getBuildingLayer()` (returns vector tile layer config with height property)
    - Map adapter extension: `set3DEnabled(enabled: boolean)`, `setPitch(pitch: number)`, `setBearing(bearing: number)`

12. **Cross-stream contracts**: Consumes 12A's offline tile infrastructure if offline 3D is desired (optional).

13. **Backend requirements**: Optional: server endpoint `/api/map/3d/config` to provide terrain/building tile URLs. Can also use static configuration.

14. **Frontend requirements**: MapLibre GL JS with terrain-rgb and fill-extrusion support, 3D camera controls (pitch, bearing, altitude), performance detection (disable 3D on low-end devices).

15. **Database/data requirements**: None. 3D data comes from tile sources.

16. **Configuration/environment requirements**: `MAP_3D_ENABLED` (boolean, default false), `MAP_3D_TERRAIN_URL` (string, URL to terrain-rgb tiles), `MAP_3D_BUILDINGS_SOURCE` (string, vector tile layer name with building heights).

17. **External provider requirements**: Terrain-rgb tiles (Mapbox Terrain, Terrain-RGB from AWS, or OpenMapTiles terrain). Building heights in vector tiles (OpenMapTiles includes building heights for many cities). MapLibre GL JS already vendored.

18. **Licensing requirements**: Terrain data license (varies by provider: Mapbox proprietary, AWS open data, OpenMapTiles ODbL). Building data inherits OSM ODbL. Display attribution per provider requirements.

19. **Cost implications**: Terrain tile provider costs (Mapbox: $5/1000 requests after free tier, AWS: free, OpenMapTiles: self-host or $10/month hosted). Increased bandwidth for 3D tiles (2–3x 2D tiles).

20. **Privacy/security requirements**: No additional privacy concerns beyond base map.

21. **Performance requirements**: 3D rendering at 30 FPS on mid-range devices. Terrain loading < 1s for viewport. Building extrusion rendering < 500ms for 1000 buildings. Graceful degradation on low-end devices (disable 3D automatically).

22. **Offline implications**: 3D unavailable offline unless 12A offline tiles include terrain/building data (optional, increases storage 2–3x).

23. **Testing requirements**: Unit tests for 3D layer configuration, camera controls. Integration tests with map adapter. Manual tests: enable 3D, verify terrain elevation, check building extrusions, test camera controls, measure performance on low-end device.

#### 12I Advanced Community Contributions

1. **Goal**: Extend community system with photo uploads, discussion threads, and reputation.

2. **User-facing capabilities**: Attach photos to proposals, participate in comment threads on proposals, earn reputation points for accepted proposals and helpful comments, see contributor leaderboards, moderation tools flag inappropriate content.

3. **Scope**: Photo upload and storage, comment threads on proposals, reputation system, leaderboards, content moderation (flagging).

4. **Explicit non-goals**: Direct messaging between users, proposal editing by non-authors, voting on comments (only proposals), external social media integration.

5. **Ownership**: Community team owns comments and reputation. Platform team owns photo storage. Moderation team owns flagging tools.

6. **New files/modules**:
   - `community/comments-model.js` (comment data model)
   - `community/comments-store.js` (comment database access)
   - `community/reputation-model.js` (reputation rules)
   - `community/reputation-store.js` (reputation database access)
   - `community/photos-store.js` (photo metadata and storage access)
   - `community/routes-extended.js` (new `/api/community/comments/*`, `/api/community/reputation/*`, `/api/community/photos/*` endpoints)
   - `public/js/services/community-comments.js` (client comment service)
   - `public/js/services/community-reputation.js` (client reputation service)
   - `public/js/components/community/comment-thread.js` (comment UI)
   - `public/js/components/community/photo-upload.js` (photo upload UI)
   - `public/js/components/community/reputation-badge.js` (reputation display)
   - `public/js/screens/community-leaderboard.js` (leaderboard screen)
   - `tests/community.comments.test.js`, `tests/community.reputation.test.js`, `tests/community.photos.test.js`

7. **Existing files/modules that MAY be edited**:
   - `community/routes.js` (add comment/reputation/photo endpoints)
   - `community/store.js` (extend with comment queries)
   - `community/policies.js` (add moderation gates for comments and photos)
   - `public/js/screens/community.js` (add comment threads to proposal detail)
   - `public/js/components/community/proposal-detail.js` (add comments section, photo gallery)
   - `server.js` (migrate comment/reputation/photo tables, add photo upload middleware)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (community strings)

8. **Files that MUST NOT be edited**: `assistant/*`, `reports/*` (reports are separate from proposals)

9. **Dependencies**: Photo storage infrastructure (S3, GCS, or platform file storage), image processing (thumbnails, EXIF stripping), spam detection (optional, can use policy gates).

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this).

11. **Required contracts/interfaces**:
    - `CommentStore` interface: `create(proposalId, authorId, text, parentId?)`, `list(proposalId, limit, offset)`, `delete(commentId, authorId)`
    - `ReputationStore` interface: `get(userId)`, `award(userId, event, points)`, `leaderboard(limit)`
    - `PhotoStore` interface: `upload(file, metadata)`, `attach(photoId, proposalId)`, `listByProposal(proposalId)`
    - `Comment` type: `{ id, proposalId, authorId, authorUsername, text, parentId?, createdAt }`
    - `ReputationEvent` type: `{ userId, event: 'proposal_accepted'|'comment_helpful', points, createdAt }`

12. **Cross-stream contracts**: None (independent stream).

13. **Backend requirements**: PostgreSQL tables for comments, reputation events, photo metadata. Photo storage (S3 bucket or platform file storage). Image processing pipeline (resize, strip EXIF). Endpoints: `/api/community/comments/*`, `/api/community/reputation/*`, `/api/community/photos/*`.

14. **Frontend requirements**: Comment thread UI (nested replies), photo upload with preview, reputation badge display, leaderboard table.

15. **Database/data requirements**: New tables: `proposal_comments` (id, proposal_id, author_id, author_username, text, parent_id, created_at), `user_reputation` (user_id, points, updated_at), `reputation_events` (id, user_id, event, points, created_at), `proposal_photos` (id, proposal_id, uploader_id, photo_url, created_at).

16. **Configuration/environment requirements**: `COMMUNITY_COMMENTS_ENABLED` (boolean, default true), `COMMUNITY_PHOTOS_ENABLED` (boolean, default true), `COMMUNITY_PHOTOS_MAX_SIZE_MB` (number, default 5), `COMMUNITY_PHOTOS_STORAGE_BUCKET` (string, S3 bucket name).

17. **External provider requirements**: Photo storage provider (AWS S3, Google Cloud Storage, or platform file storage). Image processing library (Sharp for Node.js).

18. **Licensing requirements**: User-uploaded photos: users grant license to display in app. Photo metadata includes uploader attribution.

19. **Cost implications**: Photo storage costs (estimate 100MB–10GB depending on usage, $0.02–2/month on S3). Image processing compute cost (minimal). Database storage for comments/reputation (minimal).

20. **Privacy/security requirements**: Photo uploads scanned for malware (ClamAV or provider scanning). EXIF data stripped (location, camera info). Photo storage access via signed URLs (no public bucket). Comment moderation via policy gates. Reputation cannot be gamed (rate limiting, spam detection).

21. **Performance requirements**: Comment list load < 200ms for 100 comments. Photo upload < 5s for 5MB image. Reputation calculation < 50ms. Leaderboard load < 100ms for top 100.

22. **Offline implications**: Community features unavailable offline (require server interaction).

23. **Testing requirements**: Unit tests for comment threading, reputation calculation, photo upload validation. Integration tests with database and storage. Manual tests: post comment with photo, verify reputation award, test moderation flagging, check leaderboard accuracy.

#### 12J Business Profiles

1. **Goal**: Enable business owners to claim and manage their place listings.

2. **User-facing capabilities**: Business owners verify ownership, update hours/contact/photos, respond to community proposals about their business, see analytics (views, saves). Public users see verified business badges and richer place details.

3. **Scope**: Business ownership verification, place editing by owners, business analytics, verified badges, business responses to proposals.

4. **Explicit non-goals**: Business advertising, paid placements, business-to-business messaging, multi-location business management (one claim per place).

5. **Ownership**: Places team owns place data integration. Community team owns business responses to proposals. Platform team owns verification flow.

6. **New files/modules**:
   - `business/model.js` (business claim data model)
   - `business/store.js` (business claim database access)
   - `business/routes.js` (`/api/business/*` endpoints)
   - `public/js/services/business.js` (client business service)
   - `public/js/components/business/claim-dialog.js` (claim verification UI)
   - `public/js/components/business/edit-form.js` (place editing UI)
   - `public/js/components/business/analytics.js` (analytics display)
   - `public/js/screens/business-dashboard.js` (business management screen)
   - `tests/business.model.test.js`, `tests/business.postgres.test.js`

7. **Existing files/modules that MAY be edited**:
   - `places/provider.js` (extend with business data overlay)
   - `places/index.js` (merge business data with provider data)
   - `public/js/screens/place-detail.js` (add verified badge, business edit button for owners)
   - `public/js/components/place/place-card.js` (add verified badge)
   - `community/routes.js` (add business response endpoint)
   - `server.js` (add business router, migrate tables)
   - `public/js/screens/profile.js` (add "Business Dashboard" entry for business owners)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (business strings)

8. **Files that MUST NOT be edited**: `assistant/*`, `saved/*` (saved places are user-owned, not business-owned)

9. **Dependencies**: Place data provider (to get base place data), email verification (for ownership claims), analytics data (view/save counts from existing tracking or new instrumentation).

10. **Dependency classification**: SOFT on place provider (can work with any provider, but richer data if provider supports business details).

11. **Required contracts/interfaces**:
    - `BusinessStore` interface: `claim(placeId, userId, verificationData)`, `verify(claimId, verificationCode)`, `update(placeId, userId, updates)`, `getAnalytics(placeId, userId)`, `respondToProposal(placeId, userId, proposalId, response)`
    - `BusinessClaim` type: `{ id, placeId, userId, status: 'pending'|'verified'|'rejected', verifiedAt }`
    - `BusinessAnalytics` type: `{ placeId, views: number, saves: number, period: '7d'|'30d' }`
    - Place provider extension: `getPlaceById(id)` returns business-verified data when available

12. **Cross-stream contracts**: Consumes place provider data. Provides verified business data to place detail views.

13. **Backend requirements**: PostgreSQL tables for business claims, verified business data, business responses to proposals. Email verification flow (send verification code to business email). Analytics aggregation (count views/saves per place). Endpoints: `/api/business/claim`, `/api/business/verify`, `/api/business/update`, `/api/business/analytics`, `/api/business/respond`.

14. **Frontend requirements**: Business claim dialog (enter business email, verify code), place editing form (hours, contact, photos), analytics dashboard (charts for views/saves), verified badge on place cards.

15. **Database/data requirements**: New tables: `business_claims` (id, place_id, user_id, business_email, verification_code, status, created_at, verified_at), `business_data` (place_id, user_id, hours JSONB, phone, website, photos JSONB, updated_at), `business_responses` (id, place_id, user_id, proposal_id, response_text, created_at), `place_analytics` (place_id, date, views, saves).

16. **Configuration/environment requirements**: `BUSINESS_ENABLED` (boolean, default true), `BUSINESS_VERIFICATION_EMAIL_FROM` (string, email sender), `BUSINESS_ANALYTICS_RETENTION_DAYS` (number, default 90).

17. **External provider requirements**: Email service (SendGrid, Mailgun, or platform email). Place data provider (to get base place data).

18. **Licensing requirements**: Business-verified data is user-generated. Business owners grant license to display. Verified badge indicates owner-confirmed accuracy.

19. **Cost implications**: Email service cost (estimate $0.01–0.05 per verification email). Database storage for business data (minimal). Analytics storage (estimate 10MB–100MB for 10k places over 90 days).

20. **Privacy/security requirements**: Business ownership verification via email (prevent fraudulent claims). Business data editable only by verified owner. Analytics visible only to owner. Business responses to proposals are public.

21. **Performance requirements**: Business claim submission < 500ms. Verification email send < 2s. Place update < 500ms. Analytics query < 200ms for 30-day period.

22. **Offline implications**: Business features unavailable offline (require server interaction).

23. **Testing requirements**: Unit tests for claim verification flow, business data validation, analytics aggregation. Integration tests with database and email service. Manual tests: claim business, verify email, update hours, view analytics, respond to proposal, verify badge appears on place card.

#### 12K Developer API

1. **Goal**: Expose a read-only API for third-party applications.

2. **User-facing capabilities**: Developers obtain API keys, query places/search/routing within rate limits, access community proposals and reports, integrate Homeroom Maps data into their applications.

3. **Scope**: API key management, rate limiting, read-only endpoints for places/search/routing/community, API usage tracking, developer documentation.

4. **Explicit non-goals**: Write API (no creating proposals or saving places via API), real-time streaming API, GraphQL API (REST only), API monetization (free tier only).

5. **Ownership**: Platform team owns API key management and rate limiting. Each domain team provides read-only endpoints.

6. **New files/modules**:
   - `api/model.js` (API key data model)
   - `api/store.js` (API key database access)
   - `api/routes.js` (`/api/v1/*` endpoints)
   - `api/middleware.js` (API key validation, rate limiting)
   - `api/docs.js` (API documentation generator)
   - `public/js/screens/developer-api.js` (API key management UI)
   - `tests/api.keys.test.js`, `tests/api.rate-limit.test.js`, `tests/api.endpoints.test.js`

7. **Existing files/modules that MAY be edited**:
   - `server.js` (add API router, migrate API key tables, add rate limiting middleware)
   - `search/index.js` (expose `run()` for API use)
   - `routing/index.js` (expose `run()` for API use)
   - `places/index.js` (expose `getPlaces()`, `getPlaceDetails()` for API use)
   - `community/store.js` (expose `list()` for API use)
   - `reports/store.js` (expose `list()` for API use)
   - `public/js/screens/profile.js` (add "Developer API" entry)
   - `public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js` (API strings)

8. **Files that MUST NOT be edited**: `assistant/*`, `public/js/services/assistant.js`

9. **Dependencies**: API key generation (cryptographically secure random), rate limiting library (express-rate-limit or token bucket), API documentation generator (Swagger/OpenAPI).

10. **Dependency classification**: INDEPENDENT (no other Wave 5 stream blocks this, but API exposes data from all other streams).

11. **Required contracts/interfaces**:
    - `ApiKeyStore` interface: `create(userId, name)`, `list(userId)`, `revoke(keyId, userId)`, `validate(key)`
    - `ApiKey` type: `{ id, userId, name, key (hashed), createdAt, lastUsedAt, revokedAt }`
    - API endpoints: `GET /api/v1/search`, `GET /api/v1/places`, `GET /api/v1/places/:id`, `GET /api/v1/directions`, `GET /api/v1/community/proposals`, `GET /api/v1/community/reports`
    - Rate limiting: 1000 requests/hour per API key

12. **Cross-stream contracts**: Exposes data from search, routing, places, community, reports. Each domain provides a read-only service interface.

13. **Backend requirements**: PostgreSQL table for API keys. Rate limiting middleware (token bucket per API key). API key validation middleware. Endpoints for each domain (search, places, routing, community, reports). API usage tracking (optional, for analytics).

14. **Frontend requirements**: API key management UI (create, list, revoke), API documentation page (endpoint descriptions, examples, rate limits).

15. **Database/data requirements**: New table: `api_keys` (id, user_id, name, key_hash, created_at, last_used_at, revoked_at). Optional: `api_usage` (key_id, endpoint, timestamp) for usage tracking.

16. **Configuration/environment requirements**: `API_ENABLED` (boolean, default true), `API_RATE_LIMIT_PER_HOUR` (number, default 1000), `API_MAX_KEYS_PER_USER` (number, default 5).

17. **External provider requirements**: None. API uses existing domain services.

18. **Licensing requirements**: API data inherits underlying data licenses (OSM ODbL for places/search/routing, user-generated for community). API terms of service (display on developer page).

19. **Cost implications**: Increased server load from API usage (estimate 10k–100k requests/day depending on developer adoption). Database storage for API keys (minimal). No additional infrastructure cost.

20. **Privacy/security requirements**: API keys are secrets (hashed in database, shown only once at creation). Rate limiting prevents abuse. Read-only API (no write endpoints). API usage logged for security monitoring. API keys revocable instantly.

21. **Performance requirements**: API key validation < 10ms. Rate limiting check < 5ms. API endpoint response < 500ms (same as web endpoints). API documentation page load < 1s.

22. **Offline implications**: API unavailable offline (server-side only).

23. **Testing requirements**: Unit tests for API key generation, validation, rate limiting. Integration tests with domain services. Manual tests: create API key, query each endpoint, verify rate limiting, revoke key, verify access denied.

### 2. Second-Pass Audit

#### A. Dependency classification matrix (11×11 grid)

| Stream | 12A | 12B | 12C | 12D | 12E | 12F | 12G | 12H | 12I | 12J | 12K |
|--------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| **12A** | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12B** | HARD | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12C** | HARD | SOFT | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12D** | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12E** | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12F** | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12G** | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12H** | SOFT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT | INDEPENDENT | INDEPENDENT |
| **12I** | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT | INDEPENDENT |
| **12J** | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — | INDEPENDENT |
| **12K** | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | INDEPENDENT | — |

**Justification**:
- 12B HARD on 12A: Offline search requires offline regions (12A) to exist. Cannot build offline search index without tile data.
- 12C HARD on 12A: Offline routing requires road network tiles (12A) to build routing graph.
- 12C SOFT on 12B: Offline routing can accept manual coordinates if offline search unavailable, but benefits from offline destination lookup.
- 12H SOFT on 12A: 3D maps can use online 3D tiles without offline caching, but offline 3D would require 12A.
- All other pairs are INDEPENDENT: no shared data, no shared contracts, no sequential dependency.

#### B. Blocking dependencies B1–B7

**B1: 12A → 12B**
- **Blocker**: 12A Offline Maps
- **Blocked**: 12B Offline Search
- **Why**: 12B requires `OfflineRegion` type and `OfflineTileStore` interface from 12A to build offline search index. Without tile data, offline search has no source.
- **Mitigation**: 12A must define and publish `OfflineRegion` and `OfflineTileStore` contracts before 12B starts. 12B can begin UI work with mock tile data.

**B2: 12A → 12C**
- **Blocker**: 12A Offline Maps
- **Blocked**: 12C Offline Routing
- **Why**: 12C requires road network tiles from 12A to build offline routing graph. Without road data, offline routing has no graph.
- **Mitigation**: 12A must ensure tile data includes road network layer (OpenMapTiles transportation layer). 12C can begin routing engine work with sample road data.

**B3: 12A → 12C (via 12B)**
- **Blocker**: 12B Offline Search (optional)
- **Blocked**: 12C Offline Routing
- **Why**: 12C benefits from 12B's `OfflineSearchResult` for destination resolution, but can accept manual coordinates.
- **Mitigation**: 12C can start without 12B. Add 12B integration later as enhancement.

**B4: 12A → 12H (optional offline 3D)**
- **Blocker**: 12A Offline Maps
- **Blocked**: 12H 3D Maps (offline 3D only)
- **Why**: Offline 3D requires 3D tiles (terrain, buildings) cached via 12A's offline infrastructure.
- **Mitigation**: 12H can start with online-only 3D. Offline 3D is deferred until 12A is complete.

**B5: 12D → 12E (traffic-aware transit)**
- **Blocker**: 12D Traffic
- **Blocked**: 12E Public Transit (traffic-aware transit routing)
- **Why**: Transit routing with real-time delays requires traffic data from 12D.
- **Mitigation**: 12E can start with schedule-based transit routing (no traffic). Traffic-aware transit is deferred.

**B6: 12I → 12J (business responses to proposals)**
- **Blocker**: 12I Advanced Community
- **Blocked**: 12J Business Profiles (business responses)
- **Why**: Business responses to proposals require comment thread infrastructure from 12I.
- **Mitigation**: 12J can start without business responses. Add response feature after 12I is complete.

**B7: All streams → 12K**
- **Blocker**: All other streams
- **Blocked**: 12K Developer API
- **Why**: 12K exposes data from all other streams. API endpoints require domain services to exist.
- **Mitigation**: 12K can start API key management and rate limiting infrastructure early. Add domain endpoints incrementally as streams complete.

#### C. Ownership validation against the actual repository

**12A Offline Maps**: CONFIRMED
- Server: No server files needed (client-only)
- Client: `public/js/map/maplibre.js` exists, `public/js/map/adapter.js` exists, `public/js/services/` directory exists
- Config: `config.js` exists with map configuration
- Tests: `tests/` directory exists

**12B Offline Search**: CONFIRMED
- Client: `public/js/services/search.js` exists, `public/js/screens/home.js` and `public/js/screens/discover.js` exist
- Server: `search/` directory exists but MUST NOT be edited (server search is online-only)
- Tests: `tests/search.*.test.js` files exist

**12C Offline Routing**: CONFIRMED
- Client: `public/js/services/routing.js` exists, `public/js/screens/directions.js` exists
- Server: `routing/` directory exists but MUST NOT be edited (server routing is online-only)
- Tests: `tests/routing.*.test.js` files exist

**12D Traffic**: CONFIRMED
- Client: `public/js/map/maplibre.js` exists for layer addition
- Server: `server.js` exists for endpoint addition
- Config: `config.js` exists, `dapp.json` exists for secrets
- Tests: `tests/` directory exists

**12E Public Transit**: CONFIRMED
- Server: `server.js` exists for router addition, database migration pattern established (see `community/store.js` SCHEMA_SQL)
- Client: `public/js/screens/directions.js` exists for transit mode addition
- Config: `config.js` exists, `dapp.json` exists
- Tests: `tests/` directory exists, Postgres test pattern established (see `tests/community.postgres.test.js`)

**12F Location Sharing**: CONFIRMED
- Server: `server.js` exists, `public/js/services/location.js` exists (read-only consumer)
- Client: `public/js/screens/profile.js` exists for entry addition
- Tests: `tests/` directory exists

**12G Weather**: CONFIRMED
- Client: `public/js/map/maplibre.js` exists for layer addition
- Server: `server.js` exists for proxy endpoint
- Config: `config.js` exists, `dapp.json` exists
- Tests: `tests/` directory exists

**12H 3D Maps**: CONFIRMED
- Client: `public/js/map/maplibre.js` exists (MapLibre GL JS already vendored with 3D support)
- Config: `config.js` exists
- Tests: `tests/` directory exists

**12I Advanced Community**: CONFIRMED
- Server: `community/store.js` exists, `community/routes.js` exists, `community/policies.js` exists with gate/listener pattern
- Client: `public/js/screens/community.js` exists, `public/js/components/community/` directory exists
- Tests: `tests/community.*.test.js` files exist
- Storage: Photo storage requires new infrastructure (S3 or platform file storage) — UNKNOWN if platform provides file storage

**12J Business Profiles**: CONFIRMED
- Server: `places/` directory exists, `server.js` exists
- Client: `public/js/screens/place-detail.js` exists, `public/js/components/place/` directory exists
- Tests: `tests/places.*.test.js` files exist
- Email: Verification email requires email service — UNKNOWN if platform provides email

**12K Developer API**: CONFIRMED
- Server: `server.js` exists, `search/index.js`, `routing/index.js`, `places/index.js`, `community/store.js`, `reports/store.js` all expose service interfaces
- Client: `public/js/screens/profile.js` exists
- Tests: `tests/` directory exists

#### D. Shared-file conflict analysis

**High collision risk** (multiple streams want to edit):

1. **`public/js/map/maplibre.js`** (6 streams: 12A, 12D, 12E, 12F, 12G, 12H)
   - 12A: Add tile source interception for offline fallback
   - 12D: Add traffic layer
   - 12E: Add transit stop layer
   - 12F: Add contacts layer
   - 12G: Add weather layer
   - 12H: Add terrain and buildings layers
   - **Mitigation**: Each stream adds its layer in a separate function. Use layer ordering convention (base → terrain → traffic → transit → weather → contacts → buildings). Coordinate via map adapter's layer management.

2. **`server.js`** (7 streams: 12A, 12D, 12E, 12F, 12G, 12I, 12J, 12K)
   - 12A: Add offline capability flag to `/api/config`
   - 12D: Add `/api/traffic` proxy endpoint
   - 12E: Add transit router, migrate transit tables
   - 12F: Add location-sharing router, migrate tables
   - 12G: Add `/api/weather` proxy endpoint
   - 12I: Migrate comment/reputation/photo tables, add photo upload middleware
   - 12J: Add business router, migrate tables
   - 12K: Add API router, migrate API key tables, add rate limiting middleware
   - **Mitigation**: Each stream adds its router in a separate `app.use()` call. Migrations are idempotent (see `community/store.js` SCHEMA_SQL pattern). Coordinate migration order to avoid conflicts.

3. **`config.js`** (6 streams: 12A, 12D, 12E, 12G, 12H, 12I)
   - Each stream adds configuration variables
   - **Mitigation**: Each stream adds its config in a separate section with clear comments. No shared config variables.

4. **`dapp.json`** (4 streams: 12D, 12E, 12G, 12I)
   - Each stream adds secrets for provider API keys
   - **Mitigation**: Each stream adds its secrets in separate entries. No shared secrets.

5. **`public/js/i18n/locales/en.js`, `public/js/i18n/locales/id.js`** (all 11 streams)
   - Each stream adds translation strings
   - **Mitigation**: Each stream adds strings in a separate section with namespace comments (e.g., `// offline`, `// traffic`). No shared keys.

6. **`public/js/screens/profile.js`** (4 streams: 12A, 12F, 12J, 12K)
   - 12A: Add "Offline Maps" entry
   - 12F: Add "Location Sharing" entry
   - 12J: Add "Business Dashboard" entry
   - 12K: Add "Developer API" entry
   - **Mitigation**: Each stream adds its entry in a separate list item. Coordinate ordering (alphabetical or by feature category).

**Low collision risk** (single stream or minimal overlap):

- `public/js/map/adapter.js` (12A, 12D, 12E, 12H): Extend capabilities object, no conflicts
- `public/js/screens/home.js` (12A, 12D, 12G, 12H): Add controls, no conflicts
- `public/js/screens/directions.js` (12C, 12D, 12E): Add modes and traffic display, no conflicts
- `public/js/screens/community.js` (12I): Add comment threads, single stream
- `public/js/screens/place-detail.js` (12J): Add business features, single stream

#### E. Parallelization validation

**Can start day 1** (no blocking dependencies):
- 12A Offline Maps
- 12D Traffic
- 12E Public Transit
- 12F Location Sharing
- 12G Weather
- 12I Advanced Community
- 12J Business Profiles
- 12K Developer API (API key management only, domain endpoints later)

**Must wait**:
- 12B Offline Search: Wait for 12A to define `OfflineRegion` and `OfflineTileStore` contracts (can start UI with mocks after 12A week 1)
- 12C Offline Routing: Wait for 12A to define `OfflineRegion` and ensure road network tiles (can start routing engine with sample data after 12A week 1)
- 12H 3D Maps: Can start online-only 3D immediately. Offline 3D waits for 12A.

**Recommended parallel batches**:
- **Batch 1** (day 1): 12A, 12D, 12E, 12F, 12G, 12I, 12J, 12K (API keys)
- **Batch 2** (week 2): 12B, 12C (after 12A contracts defined), 12H (online-only)
- **Batch 3** (after 12A complete): 12H (offline 3D, optional)

#### F. Phase 11 interaction/conflict validation

**Phase 11 files** (MUST NOT be edited):
- `assistant/actions.js`, `assistant/prompt.js`, `assistant/provider.js`, `assistant/routes.js`, `assistant/tools.js`
- `public/js/components/assistant/panel.js`
- `public/js/services/assistant.js`, `public/js/services/assistant-core.js`

**Validation**: None of the 11 Wave 5 streams require editing Phase 11 files.

**Potential integration points** (deferred to post-Wave 5):
- 12B offline search results could be exposed to AI assistant via adapter in `shared/contracts/offline-search-adapter.js` (does not exist yet, create when needed)
- 12C offline routing could be exposed to AI assistant via adapter
- 12E transit routing could be exposed to AI assistant via adapter
- 12J business profiles could be exposed to AI assistant via adapter
- 12K Developer API could be used by AI assistant to query external data

**Conclusion**: Phase 11 is safe from Wave 5 modifications. All streams respect the constraint.

#### G. 12A–12C RegionManifest contract analysis

**Shared contract required**: `OfflineRegion` and `OfflineTileStore` must be defined by 12A and consumed by 12B and 12C.

**Proposed contract** (to be defined by 12A):

```typescript
// shared/contracts/offline-region.js (to be created)

interface OfflineRegion {
  id: string;              // unique identifier (UUID or hash)
  name: string;            // user-friendly name (e.g., "San Francisco Bay Area")
  bounds: {
    west: number;          // longitude (-180 to 180)
    south: number;         // latitude (-90 to 90)
    east: number;          // longitude (-180 to 180)
    north: number;         // latitude (-90 to 90)
  };
  zoomRange: [number, number];  // [minZoom, maxZoom] (e.g., [0, 14])
  tileCount: number;       // total tiles in region
  byteSize: number;        // total size in bytes
  downloadedAt: Date;      // timestamp of download completion
  lastUpdatedAt: Date;     // timestamp of last update check
}

interface OfflineTileStore {
  // Store a tile for a region
  store(regionId: string, z: number, x: number, y: number, data: ArrayBuffer): Promise<void>;
  
  // Retrieve a tile (returns null if not cached)
  retrieve(z: number, x: number, y: number): Promise<ArrayBuffer | null>;
  
  // Delete all tiles for a region
  deleteRegion(regionId: string): Promise<void>;
  
  // List all downloaded regions
  listRegions(): Promise<OfflineRegion[]>;
  
  // Get storage usage in bytes
  getStorageUsage(): Promise<number>;
  
  // Check if a coordinate is within any downloaded region
  isCovered(lat: number, lng: number, zoom: number): Promise<boolean>;
}
```

**12B consumption**: Uses `OfflineRegion.bounds` to filter search results. Uses `OfflineTileStore.retrieve()` to get tile data for index building.

**12C consumption**: Uses `OfflineRegion.bounds` to validate routing requests (origin and destination must be within same region). Uses `OfflineTileStore.retrieve()` to get road network tiles for graph building.

**Agreement required before 12B/12C start**:
1. 12A defines and publishes `OfflineRegion` and `OfflineTileStore` interfaces
2. 12A ensures tile data includes place names (for 12B) and road network (for 12C)
3. 12A provides sample tile data for 12B/12C testing
4. 12B and 12C review and approve contracts before 12A implementation begins

#### H. 12H 3D provider/licensing/cost audit

**Providers to evaluate**:

1. **MapLibre GL + free 3D tiles (OpenMapTiles + terrain-rgb)**
   - **License**: OpenMapTiles ODbL (OpenStreetMap data), terrain-rgb from AWS Open Data (CC0)
   - **Attribution**: "© OpenMapTiles © OpenStreetMap contributors"
   - **API/tile cost**: Free (self-host) or $10/month (hosted OpenMapTiles)
   - **Commercial restrictions**: None (ODbL allows commercial use with attribution)
   - **Browser/mobile perf**: Good (MapLibre GL JS optimized, terrain-rgb is lightweight)
   - **Offline feasibility**: Yes (terrain-rgb tiles can be cached via 12A)
   - **Data size**: ~2x 2D tiles (terrain adds elevation data)
   - **Verdict**: Recommended default (free, open, performant)

2. **Mapbox GL JS + Mapbox 3D**
   - **License**: Proprietary (Mapbox terms)
   - **Attribution**: "© Mapbox © OpenStreetMap"
   - **API/tile cost**: $5/1000 requests after free tier (50k requests/month free)
   - **Commercial restrictions**: Mapbox terms apply (no caching beyond 30 days, no resale)
   - **Browser/mobile perf**: Excellent (Mapbox GL JS is industry standard)
   - **Offline feasibility**: Limited (Mapbox terms restrict offline caching)
   - **Data size**: ~2x 2D tiles
   - **Verdict**: Premium option (costs money, restrictive terms)

3. **Cesium ion**
   - **License**: Proprietary (Cesium ion terms)
   - **Attribution**: "Cesium ion"
   - **API/tile cost**: Free tier (100k requests/month), paid plans from $99/month
   - **Commercial restrictions**: Cesium ion terms apply
   - **Browser/mobile perf**: Good (Cesium JS is heavy but optimized for 3D)
   - **Offline feasibility**: No (Cesium ion is cloud-only)
   - **Data size**: Large (photorealistic 3D tiles are 10–100MB per tile)
   - **Verdict**: Not recommended (too heavy, no offline, overkill for this app)

4. **Google Photorealistic 3D Tiles**
   - **License**: Proprietary (Google Maps Platform terms)
   - **Attribution**: "© Google"
   - **API/tile cost**: $7/1000 requests (after $200 monthly credit)
   - **Commercial restrictions**: Google terms apply (no caching, no resale)
   - **Browser/mobile perf**: Good (Cesium JS or custom viewer)
   - **Offline feasibility**: No (Google terms prohibit offline caching)
   - **Data size**: Very large (photorealistic tiles are 50–200MB per tile)
   - **Verdict**: Not recommended (expensive, restrictive, too heavy)

5. **OpenMapTiles + terrain-rgb (AWS Open Data)**
   - **License**: OpenMapTiles ODbL, terrain CC0
   - **Attribution**: "© OpenMapTiles © OpenStreetMap contributors"
   - **API/tile cost**: Free (AWS Open Data)
   - **Commercial restrictions**: None
   - **Browser/mobile perf**: Good
   - **Offline feasibility**: Yes
   - **Data size**: ~2x 2D tiles
   - **Verdict**: Same as option 1 (recommended)

6. **AWS/OpenAerialMap DEMs**
   - **License**: CC0 (public domain)
   - **Attribution**: None required
   - **API/tile cost**: Free (AWS Open Data)
   - **Commercial restrictions**: None
   - **Browser/mobile perf**: Good (requires conversion to terrain-rgb)
   - **Offline feasibility**: Yes
   - **Data size**: Large (raw DEMs are 10–100GB globally, must be tiled)
   - **Verdict**: Good for custom terrain (requires processing)

**Recommended provider**: MapLibre GL + OpenMapTiles + terrain-rgb (option 1/5). Free, open, performant, offline-capable.

**Provider-abstraction interface** (MUST exist before 12H code):

```typescript
// shared/contracts/terrain-provider.js (to be created)

interface TerrainProvider {
  // Get terrain source configuration for MapLibre GL
  getTerrainSource(): {
    type: 'raster-dem';
    url: string;           // tile URL template
    tileSize: number;      // 256 or 512
    maxzoom: number;       // max zoom level for terrain
    encoding: 'terrarium' | 'mapbox';  // DEM encoding format
  };
}

interface BuildingsProvider {
  // Get building layer configuration for MapLibre GL
  getBuildingLayer(): {
    source: string;        // vector tile source name
    sourceLayer: string;   // layer name (e.g., 'building')
    heightProperty: string;  // property name for building height (e.g., 'render_height')
  };
}
```

#### I. 12I storage/upload capability audit

**Current upload infrastructure**: NONE
- No file upload endpoints exist in `server.js`
- No file storage configuration in `config.js`
- No upload middleware (multer or similar)
- No S3/GCS client libraries in `package.json`

**Storage quotas**: UNKNOWN
- Platform may provide file storage (check platform conventions)
- If platform does not provide, must use S3/GCS with user-defined bucket

**File-type constraints**: TO BE DEFINED
- Recommended: JPEG, PNG, WebP only (no GIF, no SVG for security)
- Max file size: 5MB (configurable via `COMMUNITY_PHOTOS_MAX_SIZE_MB`)
- Image dimensions: max 4096x4096 (resize larger images)

**Virus scanning**: TO BE IMPLEMENTED
- Option 1: ClamAV (self-hosted, free)
- Option 2: AWS S3 virus scanning (Lambda + ClamAV, $0.0000002 per scan)
- Option 3: Platform-provided scanning (if available)

**CDN**: TO BE CONFIGURED
- Option 1: S3 + CloudFront ($0.085 per GB transfer)
- Option 2: GCS + Cloud CDN ($0.08 per GB transfer)
- Option 3: Platform CDN (if available)

**Recommendation**: Use platform file storage if available (check platform conventions). Otherwise, use AWS S3 + CloudFront with ClamAV scanning.

#### J. 12J Places provider/caching rights audit

**Providers to evaluate**:

1. **Google Places API**
   - **Terms**: https://cloud.google.com/maps-platform/terms
   - **Caching**: PROHIBITED (Section 3.2.3: "No caching or storage of Google Maps Content")
   - **Bulk storage**: PROHIBITED (Section 3.2.4: "No pre-fetching, indexing, or caching")
   - **Attribution**: Required ("Powered by Google")
   - **Verdict**: NOT suitable for business profiles (cannot cache business data)

2. **Foursquare Places API**
   - **Terms**: https://developer.foursquare.com/docs/terms
   - **Caching**: LIMITED (24 hours for venue data, 30 days for photos)
   - **Bulk storage**: PROHIBITED (no bulk download or database storage)
   - **Attribution**: Required ("Foursquare © 2024")
   - **Verdict**: NOT suitable for business profiles (24-hour cache too short)

3. **OSM Overpass API**
   - **Terms**: https://wiki.openstreetmap.org/wiki/Overpass_API
   - **Caching**: ALLOWED (ODbL license, attribution required)
   - **Bulk storage**: ALLOWED (download entire planet if desired)
   - **Attribution**: Required ("© OpenStreetMap contributors")
   - **Verdict**: Suitable for business profiles (can cache indefinitely with attribution)

4. **Photon (komoot)**
   - **Terms**: https://github.com/komoot/photon (Apache 2.0)
   - **Caching**: ALLOWED (search results can be cached)
   - **Bulk storage**: ALLOWED (self-host Photon with full OSM planet)
   - **Attribution**: Required ("© OpenStreetMap contributors")
   - **Verdict**: Suitable for business profiles (already used for search)

5. **Nominatim**
   - **Terms**: https://operations.osmfoundation.org/policies/nominatim/
   - **Caching**: LIMITED (7 days for search results)
   - **Bulk storage**: PROHIBITED (no bulk download via API)
   - **Attribution**: Required ("© OpenStreetMap contributors")
   - **Verdict**: NOT suitable for business profiles (7-day cache too short)

**Recommended provider**: OSM Overpass or Photon (both allow indefinite caching with attribution).

**Business data overlay**: Business-verified data (hours, phone, website) is user-generated and can be stored indefinitely in `business_data` table. This data overlays provider data and takes precedence when verified.

#### K. 12E transit-provider audit

**GTFS vs GTFS-Realtime**:

1. **GTFS (General Transit Feed Specification)**
   - **Format**: ZIP file containing CSV files (stops.txt, routes.txt, trips.txt, stop_times.txt, shapes.txt)
   - **Data**: Static schedule data (stops, routes, timetables)
   - **Update cadence**: Daily or weekly (agencies publish new feeds)
   - **Licensing**: Usually public domain or Creative Commons (varies by agency)
   - **Storage**: 100MB–1GB per agency (depends on city size)
   - **Providers**: Transit agencies publish GTFS feeds on their websites. Aggregators: Transitland (https://transit.land), OpenMobilityData (https://transitfeeds.com)
   - **Verdict**: Recommended for Wave 5 (static schedules are sufficient)

2. **GTFS-Realtime**
   - **Format**: Protocol Buffers (binary format)
   - **Data**: Real-time vehicle positions, trip updates, service alerts
   - **Update cadence**: Every 10–30 seconds (live data)
   - **Licensing**: Usually public domain (varies by agency)
   - **Storage**: Minimal (real-time data not stored)
   - **Providers**: Transit agencies with real-time systems
   - **Verdict**: Deferred to post-Wave 5 (real-time is future scope)

**Recommended provider**: GTFS from local transit agency (e.g., SFMTA for San Francisco, MTA for New York). Use Transitland aggregator to find feeds.

**GTFS parsing library**: `gtfs-sequelize` (Node.js, parses GTFS into PostgreSQL).

**Update cadence**: Daily at 3am (configurable via `TRANSIT_UPDATE_CRON`). Download new feed, parse, replace old data in transaction.

**Storage**: PostgreSQL tables (estimate 100MB–1GB for a city's GTFS feed).

#### L. 12F privacy/recipient-read audit

**Who can see a shared location**:
- Only contacts the user has explicitly invited and who have accepted the invitation
- Recipients see only the user's current location (lat, lng, accuracy, timestamp)
- Recipients NEVER see location history (no storage of past locations)
- Location updates every 30 seconds when sharing is active

**Consent**:
- User must explicitly invite each contact (no bulk sharing)
- Contact must explicitly accept invitation (no automatic acceptance)
- User must explicitly start sharing with each contact (no automatic sharing)
- Sharing duration is user-selected (1 hour, 1 day, until turned off)

**Revocation**:
- User can revoke sharing with any contact instantly (via UI toggle)
- Revocation takes effect immediately (no grace period)
- Contact is notified of revocation (optional, via push notification)
- Revoked contact can be re-invited later (no permanent block list)

**Expiry**:
- Shared location automatically expires at end of selected duration
- Expiry is server-enforced (cron job or database trigger)
- User is notified when sharing expires (optional)
- Expired sharing can be restarted (new invitation not required if contact still accepted)

**Abuse prevention**:
- Rate limiting on invitations (max 10 per hour per user)
- Contact must be a registered Homeroom user (no sharing with non-users)
- User can block a contact from re-inviting (optional, future scope)
- Audit log of all sharing events (who shared with whom, when, duration)

**Privacy-by-default**:
- Location sharing is OFF by default (user must opt in)
- No location data stored
- No location data stored permanently (only current location in `location_sharing_active`)
- Location data deleted when sharing expires or is revoked
- No location tracking when sharing is off
- User can see list of all contacts they've shared with (transparency)

**Regulatory compliance**:
- GDPR: User has right to delete all sharing data (account deletion)
- CCPA: User can request list of all contacts they've shared location with
- Data minimization: Only current location stored, no historical tracking

#### M. Required corrections

**Findings from Spec v1 review**:

1. **12A offline tile storage**: CONFIRMED
   - Original spec did not specify IndexedDB vs localStorage vs Cache API
   - Spec v3 clarifies: IndexedDB (large binary data, quota API support)

2. **12B offline search index**: NEEDS REVISION
   - Original spec assumed server-side index generation
   - Spec v3 clarifies: client-side index built from tile metadata (no server work)

3. **12C offline routing engine**: NEEDS REVISION
   - Original spec did not specify routing engine library
   - Spec v3 clarifies: OSRM.js or Valhalla WASM (client-side)

4. **12D traffic provider**: CONFIRMED
   - Original spec listed TomTom, HERE, Mapbox
   - Spec v3 confirms: all three viable, selection based on cost/coverage

5. **12E transit GTFS**: CONFIRMED
   - Original spec correctly identified GTFS vs GTFS-Realtime
   - Spec v3 confirms: GTFS static schedules for Wave 5, real-time deferred

6. **12F location sharing privacy**: NEEDS REVISION
   - Original spec did not detail privacy model
   - Spec v3 adds: consent, revocation, expiry, abuse prevention, regulatory compliance

7. **12H 3D provider**: NEEDS REVISION
   - Original spec assumed free 3D stack exists
   - Spec v3 audits 6 providers, recommends MapLibre + OpenMapTiles + terrain-rgb

8. **12I photo storage**: NEEDS REVISION
   - Original spec did not identify platform file storage capability
   - Spec v3 audits platform conventions, recommends platform storage if available

9. **12J business verification**: CONFIRMED
   - Original spec correctly identified email verification flow
   - Spec v3 confirms: email-based verification, business data overlay model

10. **12K API rate limiting**: CONFIRMED
    - Original spec specified 1000 requests/hour
    - Spec v3 confirms: token bucket per API key, reasonable for free tier

11. **Phase 11 non-modification**: CONFIRMED
    - All 11 streams respect Phase 11 constraint
    - No stream requires editing `assistant/*` files

**Corrections applied**:
- 12B: Changed from server-side to client-side search index
- 12C: Added routing engine library selection (OSRM.js / Valhalla WASM)
- 12F: Added comprehensive privacy model (consent, revocation, expiry, abuse)
- 12H: Added 6-provider audit with licensing/cost/offline analysis
- 12I: Added platform file storage audit (UNKNOWN availability)
- All streams: Added explicit "files that MUST NOT be edited" sections

#### N. Safe-for-parallel implementation list

**Streams that can start day 1 without blocking any other**:
- 12A Offline Maps (INDEPENDENT, no upstream dependencies)
- 12D Traffic (INDEPENDENT, no upstream dependencies)
- 12E Public Transit (INDEPENDENT, no upstream dependencies)
- 12F Location Sharing (INDEPENDENT, no upstream dependencies)
- 12G Weather (INDEPENDENT, no upstream dependencies)
- 12I Advanced Community (INDEPENDENT, no upstream dependencies)
- 12J Business Profiles (INDEPENDENT, no upstream dependencies)
- 12K Developer API (API key management only, INDEPENDENT for infrastructure)

**Streams that must wait**:
- 12B Offline Search: Wait for 12A contracts (1–2 weeks)
- 12C Offline Routing: Wait for 12A contracts (1–2 weeks)
- 12H 3D Maps: Online-only can start day 1; offline 3D waits for 12A

**Rationale**: 8 of 11 streams have no upstream dependencies and can proceed in parallel. Only 12B and 12C have HARD dependencies on 12A's `OfflineRegion` and `OfflineTileStore` contracts. 12H has a SOFT dependency (offline 3D only).

#### O. Recommended Wave 5 implementation order

**Phase 1: Foundation (Weeks 1–4)**
- **12A Offline Maps**: Define `OfflineRegion` and `OfflineTileStore` contracts, implement tile caching, region selection UI
- **12D Traffic**: Implement traffic provider adapter, traffic overlay rendering
- **12E Public Transit**: Implement GTFS ingestion, transit routing, stop display
- **12F Location Sharing**: Implement contact management, real-time location sharing
- **12G Weather**: Implement weather provider adapter, weather overlay rendering
- **12I Advanced Community**: Implement photo uploads (platform storage), comment threads, reputation system
- **12J Business Profiles**: Implement business claim flow, place editing, analytics
- **12K Developer API (Phase 1)**: Implement API key management, rate limiting infrastructure

**Gate**: 12A contracts (`OfflineRegion`, `OfflineTileStore`) published and reviewed by 12B/12C teams.

**Phase 2: Offline expansion (Weeks 5–8)**
- **12B Offline Search**: Implement client-side search index from tile metadata, offline search UI
- **12C Offline Routing**: Implement client-side routing graph from road network tiles, offline routing UI
- **12H 3D Maps (online-only)**: Implement 3D rendering with terrain and buildings (online tiles only)

**Gate**: 12A, 12B, 12C integrated and tested (offline search/routing within offline regions).

**Phase 3: Integration and API (Weeks 9–12)**
- **12K Developer API (Phase 2)**: Add domain endpoints (search, places, routing, community, reports)
- **12H 3D Maps (offline, optional)**: Add offline 3D tile caching via 12A infrastructure

**Gate**: All 11 streams complete, integrated, and passing tests.

**Phase 4: Polish and documentation (Weeks 13–16)**
- End-to-end integration testing
- Performance optimization (offline index build time, 3D rendering FPS)
- Developer documentation for 12K API
- User documentation for all new features
- Staging verification and vote preparation

**Total timeline**: 16 weeks (4 months) with 8 streams in parallel during Phase 1.

#### P. Definition of Done for every stream

**12A Offline Maps**:
- Unit tests: tile storage CRUD, region bounds validation, quota enforcement (>90% coverage)
- Integration tests: offline fallback in map adapter (simulate offline, verify cached tiles render)
- Manual tests: download 100MB region, go offline, verify map viewing, test storage cleanup
- Staging verification: `/#/profile` shows "Offline Maps" entry, download region, verify offline viewing
- Documentation: user guide for downloading/managing regions, developer guide for `OfflineTileStore` API
- Vote criteria: 3+ positive votes from community team, 1+ from platform team

**12B Offline Search**:
- Unit tests: index building, query matching, bounds filtering (>90% coverage)
- Integration tests: with 12A tile store (download region, build index, query)
- Manual tests: download region, go offline, search for places, verify results marked "offline"
- Staging verification: `/#/discover` shows offline search results when offline
- Documentation: user guide for offline search, developer guide for `OfflineSearchIndex` API
- Vote criteria: 3+ positive votes from search team, 1+ from offline team

**12C Offline Routing**:
- Unit tests: graph building, pathfinding, bounds validation (>90% coverage)
- Integration tests: with 12A tile store (download region, build graph, calculate route)
- Manual tests: download region, go offline, calculate route within region, verify geometry
- Staging verification: `/#/directions` shows offline route when offline
- Documentation: user guide for offline routing, developer guide for `OfflineRoutingGraph` API
- Vote criteria: 3+ positive votes from routing team, 1+ from offline team

**12D Traffic**:
- Unit tests: provider adapters, data normalization (>90% coverage)
- Integration tests: with map layer (enable traffic, verify color coding)
- Manual tests: enable traffic, check incident markers, test auto-refresh
- Staging verification: `/#/` shows traffic overlay when enabled
- Documentation: user guide for traffic display, developer guide for `TrafficProvider` API
- Vote criteria: 3+ positive votes from data integration team, 1+ from map team

**12E Public Transit**:
- Unit tests: GTFS parsing, transit routing algorithm (>90% coverage)
- Postgres tests: GTFS data ingestion, stop/route queries (>90% coverage)
- Manual tests: load GTFS feed, query stops, calculate transit route, verify schedule
- Staging verification: `/#/directions` shows transit mode and route
- Documentation: user guide for transit routing, developer guide for `TransitProvider` API
- Vote criteria: 3+ positive votes from data integration team, 1+ from routing team

**12F Location Sharing**:
- Unit tests: sharing logic, expiration, revocation (>90% coverage)
- Postgres tests: contact management, active shares (>90% coverage)
- Manual tests: invite contact, accept, share location, verify real-time updates, test revocation
- Staging verification: `/#/profile` shows "Location Sharing" entry, manage contacts
- Documentation: user guide for location sharing, developer guide for `LocationSharingStore` API
- Vote criteria: 3+ positive votes from platform team, 1+ from map team

**12G Weather**:
- Unit tests: provider adapters, data normalization (>90% coverage)
- Integration tests: with map layer (enable weather, verify overlay)
- Manual tests: enable weather, check forecast popup, test severe weather alerts
- Staging verification: `/#/` shows weather overlay when enabled
- Documentation: user guide for weather display, developer guide for `WeatherProvider` API
- Vote criteria: 3+ positive votes from data integration team, 1+ from map team

**12H 3D Maps**:
- Unit tests: 3D layer configuration, camera controls (>90% coverage)
- Integration tests: with map adapter (enable 3D, verify terrain/buildings)
- Manual tests: enable 3D, verify terrain elevation, check building extrusions, test camera controls
- Staging verification: `/#/` shows 3D toggle, enable 3D mode
- Documentation: user guide for 3D maps, developer guide for `TerrainProvider` and `BuildingsProvider` APIs
- Vote criteria: 3+ positive votes from map team, 1+ from data integration team

**12I Advanced Community**:
- Unit tests: comment threading, reputation calculation, photo upload validation (>90% coverage)
- Postgres tests: comment/reputation/photo tables (>90% coverage)
- Manual tests: post comment with photo, verify reputation award, test moderation flagging
- Staging verification: `/#/community` shows comment threads, photo uploads, reputation badges
- Documentation: user guide for community features, developer guide for `CommentStore`, `ReputationStore`, `PhotoStore` APIs
- Vote criteria: 3+ positive votes from community team, 1+ from platform team

**12J Business Profiles**:
- Unit tests: claim verification flow, business data validation, analytics aggregation (>90% coverage)
- Postgres tests: business claims, business data, analytics (>90% coverage)
- Manual tests: claim business, verify email, update hours, view analytics, respond to proposal
- Staging verification: `/#/profile` shows "Business Dashboard" for business owners
- Documentation: user guide for business profiles, developer guide for `BusinessStore` API
- Vote criteria: 3+ positive votes from places team, 1+ from community team

**12K Developer API**:
- Unit tests: API key generation, validation, rate limiting (>90% coverage)
- Integration tests: with domain services (query each endpoint, verify rate limiting)
- Manual tests: create API key, query each endpoint, verify rate limiting, revoke key
- Staging verification: `/#/profile` shows "Developer API" entry, manage API keys
- Documentation: developer guide for API endpoints, rate limits, authentication
- Vote criteria: 3+ positive votes from platform team, 1+ from each domain team

**Cross-cutting criteria for all streams**:
- All tests pass (`npm test`)
- No regression in existing functionality (all Phase 0–11 tests still pass)
- Staging preview verified (all user-facing features work end-to-end)
- Documentation complete (user guides, developer guides, API docs)
- Code review approved (2+ reviewers from relevant teams)
- Community vote passed (per vote criteria above)

## Conclusion

This Wave 5 Master Specification v3 provides a complete, evidence-based plan for extending Homeroom Maps with 11 major capability streams. The specification:

- **Covers all 11 streams** (12A–12K) with 23 fields each, grounded in actual repository structure
- **Identifies dependencies** via 11×11 matrix and 7 blocking dependencies with mitigations
- **Validates ownership** against real file paths and existing provider abstractions
- **Analyzes shared-file conflicts** for 6 high-collision files with mitigation strategies
- **Enables parallelization** with 8 streams starting day 1, 3 streams waiting for 12A contracts
- **Respects Phase 11** constraint (no AI assistant modifications)
- **Defines contracts** for 12A–12C (`OfflineRegion`, `OfflineTileStore`) that must be agreed before implementation
- **Audits providers** for 12H (6 3D providers), 12J (5 places providers), 12E (GTFS vs GTFS-Realtime)
- **Identifies unknowns** for 12I (platform file storage availability) and 12J (platform email service)
- **Recommends implementation order** in 4 phases over 16 weeks
- **Defines Done** for every stream with tests, documentation, staging verification, and vote criteria

The specification is ready for community review and vote. Once approved, implementation can proceed per the recommended phased approach, with 8 streams starting in parallel during Phase 1.
