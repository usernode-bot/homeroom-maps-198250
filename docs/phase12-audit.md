# Phase 12 Final Integration Audit (Change 8100)

Date: 2026-10-13 · Branch: `dev/marleeehilpert-phase-12-final-integration-1791875475661`
Scope: read-only audit of Phase 12A–12K (Wave 5) before launch regression testing.
Method: repository inspection, targeted greps, five parallel per-stream verifications, one
full test run. No code, migrations, tests or configuration were modified.

## 1. Repository and test evidence

- Working tree clean at audit start; last commit `5ebe04b` (12K, PR #48).
- Commit → phase map: 12A `bf24f2d`, 12B `8c76787`, 12D `bd8f76b`, 12E slice 1 `61241e9`,
  12F `5a678b4`, 12G `c9df5cd`, 12H `552bcee`, 12I slice 1 `17fb341`, 12J `d49caaf` (#47),
  12K `5ebe04b` (#48), PR #17 recovery `94ec0f7` (#50). Baseline: `c86578f`.
- **Test run**: `npm test` (node --test tests/*.test.js) — first run failed 12 test files with
  `Error: Cannot find module 'express'` because node_modules was absent in this checkout;
  after `npm ci --no-audit --no-fund` the suite ran **820 tests, 820 pass, 0 fail, 0 skipped**
  (duration ≈ 5.9 s). Postgres-backed tests ran for real against throwaway schemas via
  `INLOOP_DATABASE_URL` — none were skipped or stubbed.
- Frozen Phase 11 paths (`/assistant/`, `public/js/components/assistant/`,
  `public/js/services/assistant.js`) are untouched: `git diff c86578f..HEAD` on them is empty.
- PR #17 recovery (`94ec0f7`) contains exactly 3 files (recovery doc, patch, module-graph
  regression test) and is correctly **not applied** to the tree — it is a proposal awaiting
  its own approval, kept separate from the Phase 12 roadmap as required.

## 2. Verified status per phase

| Phase | Status | Evidence |
|---|---|---|
| 12A offline tile store | **Implemented** | Tile store (`putTile`/`getTile(regionId required)`/`deleteRegion`/`listRegions`/`regionUsage`/`totalUsage`), IndexedDB `hm-offline` with 3 stores, `offline/region-manifest.js` v1 manifest, real `public/sw.js` (map resources only, never `/api/*`). |
| 12B offline search | **Implemented** | `offline-search-index.js` complete; hard dependency on 12A satisfied. |
| 12C offline routing | **Deliberately absent (engine not built)** | `offline-routing-capability.js:55` `ENGINE_AVAILABLE = false`; `OFFLINE_ROUTING_ENABLED` default false (spec said true — documented deviation, honest UI copy). |
| 12D traffic | **Partial — gated shell** | T1 gate ships closed (no `docs/traffic-provider-rights.md`); `traffic/provider.js:34` registry empty; spec's `/api/traffic/flow` and `/api/traffic/incidents` do not exist — capability surfaces only via `/api/config`; client derivation (jam layers `maplibre.js:502-551`, fail-closed at `map.js:160`/`home.js:575-583`, `?traffic=open`) works. |
| 12E transit | **Slice 1 only (~15%)** | PT1 gate + empty registry exist; `resolveTransitConfig` exists but `TRANSIT_ENABLED` is absent from config.js and the resolver is never called in server.js; model/store/routes/client files, dapp.json secret and both spec tests missing. |
| 12F location sharing | **Implemented** (deliberate redesign) | `sharing/model.js:28` `DURATIONS = [60, 480, 1440]` (no "until turned off"); fix truncation 4dp + ceiled accuracy; `sharing_sessions` (immutable embedded fix) + `sharing_recipients`; expiry ends+erases (`store.js:122-130`) with purge ~24 h later; 7 routes mounted (`server.js:464-471`); membership via platform directory, fail-closed 503 on unreachable; client wired (`profile.js:189-201`, `#/?share=<id>` markers `home.js:410-455`). Live push (WebSocket/SSE) absent — polling ~30 s. |
| 12G weather | **Partial — gated shell** | W1 gate closed (no `docs/weather-provider-rights.md`); only `current({lat,lng,lang})`; route `GET /api/weather/current` (`server.js:551`, error map 544-549), TTL 10 min; client six-state panel + `?weather=open`. Missing: forecast/overlay endpoints, forecast-popup, weather-layer, severe alerts. |
| 12H map presentation | **Implemented** | MAP_3D default true with fail-closed `MAP_3D_TERRAIN_URL` + attribution pairing; community-jam layers verified. |
| 12I community | **Slice 1 only** | Reputation model (6 closed events, 3 display levels), append-only `reputation_events` ledger with SUM-on-read and idempotency partial unique index; listeners on shared `policies` registry (`server.js:84-102`). Slice 2+ (comments, photo upload pipeline, leaderboards, moderation flagging, badge UI) missing; `totalFor` has zero callers (dead code). |
| 12J business profiles | **Implemented** (deliberate redesign) | Lifecycle pending/verified/rejected/withdrawn/superseded with TRANSITIONS (`model.js:59-64`); manual review replaces spec's email-code flow ("Login is never proof of ownership", `model.js:9-12`); 30-day pending expiry, 7-day rejection cool-down, max 3 pending; 5 tables, 11 routes; client screens complete. Missing: business responses to proposals, analytics, profile photos. |
| 12K developer API | **Implemented** | SHA-256 hashed keys (`api/keys.js:42-44`), plaintext returned once, `hm_live_` + 43-char base64url, constant-time compare, `api_keys` staging:private, cap counts ACTIVE keys, uniform `invalid_key` on expiry, scope narrowing → 403, kill switch 503, strict projector allowlists, OpenAPI 1:1 with routes (test-enforced). Deviations [LOW]: 60/min limit + directions cost 3 vs spec 1000/hour (`config.js:336-339`); `/api/v1/reports` vs spec's `/api/v1/community/reports`. |

Second-Pass Audit dependency matrix holds: 12B hard-on-12A, 12C hard-on-12A + soft-on-12B
(satisfied given 12C's deliberate absence), 12H soft-on-12A, rest independent.

## 3. Findings by severity

### Critical blockers
None found. No forbidden-file edits, no Phase 11 freeze violation, no SQL injection vectors
(all queries parameterized; the only interpolation is placeholder strings for a fixed IN-list
at `saved/profiles.js:68-72`), no hardcoded secrets, FK direction correct, all DDL idempotent.

### High-priority defects
1. **Platform conventions not adopted (guests + preview time).** Zero occurrences of
   `account_required` repo-wide; server.js has no guest-token branch, no `req.now` /
   `x-usernode-now` handling, and reports expiry computes from SQL `NOW()`
   (`reports/store.js:99-101`) instead of an injected clock. A signed-out visitor gets a
   plain 401 instead of the platform's join sheet, and time-dependent screens cannot be
   previewed as of a chosen moment. Convention sections: "Guests", "Time-dependent features".

### Integration inconsistencies (medium)
2. **`weather/provider-policy.js:32`** — `RIGHTS_DOC_PATH = 'docs/weather-provider-rights.md'`
   is CWD-relative while the three sibling gates use `path.join(__dirname, '..', 'docs', …)`.
   Every failure branch still fails closed (`permitted:false, blocker:'W1'`, including the
   read catch at lines 44-53), so this is a misleading-reason/fragility defect, not a security
   hole.
3. **12E wiring gap** — `transit/index.js` exports `resolveTransitConfig` but nothing calls it
   and `TRANSIT_ENABLED` is absent from config.js. Documented in `transit/index.js:11-13` as
   deliberate, but it makes the module dead code that reads as wired.
4. **12D capability surface narrower than spec** — no `/api/traffic/*` endpoints at all;
   everything rides `/api/config`. Tests that assert spec-level endpoints do not exist yet
   (noted in `tests/traffic.config.test.js:137` re `trafficDelay` in routing responses).

### Performance / security risks (low–medium)
5. `api/keys.js:184-190` `keys.list()` is unbounded (no LIMIT) — fine at current scale, grows
   with key count.
6. No inbound rate limit on internal `/api/*` GETs; `/health` and `/api/config` are public and
   unlimited. Acceptable for launch, worth a note.
7. `docs/developer-api.md:110-114` publishes the staging demo key — harmless in staging only;
   make sure it never becomes a production key.
8. Rate-limit config (60/min, directions cost 3) diverges from spec's 1000/hour — stricter,
   so safe, but API consumers should be told.

### Non-blocking improvements
9. Triplicated registry/error-factory boilerplate (~60 lines) across `traffic/`, `transit/`,
   `weather/` — extract when the next provider adapter lands.
10. `reputation-model.js` `totalFor()` has zero callers — remove or wire in slice 2.
11. Place-detail screen has no own dapp.json test route (covered indirectly).
12. Chromeless redirect hardcodes the platform slug (`server.js:656,663`) — derive from env.

## 4. Proposed fix order (post-approval, each its own change)

1. Adopt the guest contract (`account_required` + guest-token branch) and the `req.now` /
   `x-usernode-now` preview-time convention in server.js — platform-convention gap, highest
   real-world impact.
2. Align `weather/provider-policy.js` RIGHTS_DOC_PATH with the sibling pattern
   (`path.join(__dirname, '..', 'docs', …)`).
3. Wire `resolveTransitConfig` into config.js/server.js behind a false-by-default flag, or
   delete the dead export until slice 2.
4. Bound `keys.list()` with a LIMIT.
5. Fill the four rights docs (`docs/{offline,traffic,transit,weather}-provider-rights.md`)
   when operators actually authorize providers — all gates fail closed until then, by design.

## 5. Remaining external dependencies

- **Four provider-rights documents do not exist**, so B2 (tile download), T1 (traffic),
  PT1 (transit) and W1 (weather) all ship closed; no env var can bypass them.
  `TRAFFIC_ENABLED` defaults true in config.js (`config.js:235`) but the T1 gate
  independently closes the capability, so this is harmless.
- No map-tile/search/routing provider adapters or API keys are configured; staging runs on
  committed defaults. `MAP_3D_TERRAIN_URL` unset → 3D terrain fail-closed.
- `USERNODE_LLM_PROXY_TOKEN` / storage tokens absent in staging by design — AI/storage
  features degrade gracefully (verified detection paths).
- PR #17 recovery patch is **unapplied** and needs its own approval; it is self-contained,
  patched tree tested 651/651 + 62/66 browser checks (the 4 browser failures are
  environment-dependent map-tile ones that fail on main too).
- 12E slices 2+, 12I slices 2+, 12C engine, 12D/12G endpoint expansions remain unbuilt per
  spec — documented as deliberate, not regressions.

## 6. Recommendation

**Conditional GO** for full regression testing, conditional on:
1. the group acknowledging that 12C/12E(slices)/12I(slices) and the 12D/12G expansions are
   intentionally absent (they are honestly gated, not silently broken);
2. the four high/medium findings (guests, req.now, weather path, transit wiring) being
   scheduled as follow-up changes rather than launch blockers;
3. the PR #17 recovery remaining on its own approval track.

Nothing audited here blocks opening regression testing against the implemented surface:
11 of 12 subphases are implemented or deliberately gated, 820/820 tests pass against a real
database, the frozen Phase 11 surface is untouched, and every provider gate fails closed.