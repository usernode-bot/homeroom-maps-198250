# Routing provider evaluation (Phase 4 — Directions)

The Directions feature needs a real routing engine behind a pluggable
`RoutingProvider` adapter. This document records the evaluation of the three
candidate engines, the selection, and what each candidate would need if the
app switches later. Like `docs/provider-comparison.md` (search), this is the
reasoning the adapter structure encodes: the app talks to a normalized
contract (`routing/provider.js`), never to an engine.

**Scope of the decision.** What we need today: point-to-point routing with
waypoints, alternative routes, per-mode routing (at least driving; walking
and cycling welcome), geometry + distance + duration + legs/steps for the
future navigation phase (Phase 8), no API key in client code, and a free or
cheap tier honest enough for a community app.

## Candidates

| | OSRM | Valhalla | GraphHopper |
|---|---|---|---|
| **API** | REST, `GET /route/v1/{profile}/…` | REST, `POST /route` (JSON action object) | REST, `GET /api/route` (or self-hosted `POST`) |
| **Response** | `code`, `routes[]` with `geometry` (GeoJSON or polyline), `distance` (m), `duration` (s), `legs[]` with `steps[]` and `maneuver{type, modifier, location}`, `refs` via steps | `trip` (or `alternatives[]`) with `shape` (encoded polyline), `length` (km), `time` (s), `legs[]` with `maneuvers[]` | `paths[]` with `points` (encoded polyline or GeoJSON), `distance` (m), `time` (ms), `instructions[]` per path |
| **Modes** | driving, walking, cycling (one profile per request; motorcycle is not modelled) | driving (+`motorcycle` costing), walking, cycling, bus | car, foot, bike, motorcycle (paid/self-host), truck |
| **Alternatives** | `alternatives=true` — up to ~3 real alternatives, returned as separate `routes[]` entries | `alternatives` (count) in the action object | `alternative_routes` (share/goal params) |
| **Waypoints (via)** | Yes — coordinates in the URL, ordered (multi-route leg splitting) | Yes — `waypoints` array with `via` types | Yes — `points` array |
| **Transit** | No | No (separate Valhalla/transit or an external OTP needed) | No (separate GTFS product) |
| **Live traffic** | No (durations are profile-based estimates; the `traffic` profile plugin needs upstream data few public instances run) | Time-dependent costing can use historic speed data; live traffic only with a data feed | Live traffic on the paid hosted API |
| **Restrictions surfaced** | Not in the route response (weight/penalty modelled internally; turn restrictions honoured but not reported per route) | `avoid_*` parameters (tolls, highways, ferries); closed-road awareness depends on data | `avoid` parameters; restrictions honoured but not itemised per route |
| **Licensing (engine)** | BSD-2 (OSRM itself) on OSM data | BSD-2 on OSM data | Apache-2.0 |
| **Data attribution** | © OpenStreetMap contributors (ODbL via the data) | © OpenStreetMap contributors | © OpenStreetMap contributors |
| **Hosted / self-host** | Both: `router.project-osrm.org` (demo, free, courtesy limits) or a self-hosted instance | Self-hosted, or coordinate-based hosted options via vendors | Hosted API (free tier ~ limited requests/day) or self-hosted |
| **Key required (hosted demo)?** | No | No (self-host only, realistically) | Yes (hosted); no if self-hosted |
| **Rate limits (demo)** | Fair-use; bursts throttled (HTTP 429) | n/a self-hosted | Free tier: per-day cap |

## Why OSRM first

- **It is the only candidate with a public, keyless, zero-config endpoint**
  (`https://router.project-osrm.org`), so Directions works end-to-end for
  the whole group with **no secret to store and no key that can leak** — the
  security rule ("never hardcode API keys") is satisfied by not needing one.
  The app still treats the endpoint as a config value (`OSRM_URL`), so a
  self-hosted instance is a one-env-var change.
- **The response shape is the closest match to our normalized model**:
  GeoJSON geometry, metres, seconds, and `legs[].steps[]` with
  `maneuver{type, modifier, location}` — exactly the fields Phase 8
  navigation will consume. Nothing needs re-shaping twice.
- **Alternatives, waypoints and steps are all supported** on the free
  endpoint, so the full Phase 4 UX is real, not placeholder.
- **Attribution is simple and known**: © OpenStreetMap contributors.

## Honest limits of the OSRM choice (documented, not hidden)

- **Durations are profile-based estimates, not live traffic.** No
  `traffic: true` appears anywhere in the capabilities; the UI never shows a
  traffic indicator, and no copy implies live conditions.
- **Motorcycle and transit are not offered.** OSRM's demo profiles are
  `driving`, and self-hosted instances commonly add `foot`/`bike`. The
  mode list the UI shows comes from the server's `OSRM_PROFILES` config
  (`mode:profile` pairs), so a self-hosted instance with bike/foot profiles
  unlocks those modes with a config change only — no code change.
- **Restrictions are not itemised** in the OSRM response; `restrictions` in
  our model stays `[]` and the route summary shows its honest "road details
  unavailable" fallback when nothing was surfaced.
- **The public demo endpoint is a courtesy service**, not an SLA: bursts
  can be throttled (handled as `rate_limited` → "Routing is busy right now")
  and it should not be leaned on for heavy use. The server also rate-limits
  itself (token bucket, ~5 burst / 1 per second) to stay polite.

## The switch later

Swapping provider is a server-side change by design:

1. Implement the `RoutingProvider` contract (`routing/provider.js`) in a new
   `routing/providers/<name>.js` — `isConfigured()`, `capabilities`,
   `route(request)` returning normalized `RouteResult[]`.
2. Register it in `routing/index.js` and set `ROUTING_PROVIDER=<name>`
   (plus its URL/key env vars, declared in `dapp.json`).
3. The client learns the new capabilities from `/api/config`; the UI
   (travel-mode chips, waypoint affordances, alternatives list) follows
   automatically. No UI change.

The two placeholder adapters already committed show the seam:
`routing/providers/valhalla.js` and `routing/providers/graphhopper.js`
answer `not_configured` with their exact setup instruction until someone
connects them.

## Verdict

**OSRM via `router.project-osrm.org` (configurable) is the Phase 4
provider**: real routes, real alternatives, real steps for Phase 8, no keys,
honest limits. Valhalla is the strongest future candidate for richer
costing and motorcycle support (self-hosted); GraphHopper is the strongest
hosted option if the group ever wants traffic data under an SLA.
