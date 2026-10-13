# Developer API (Phase 12K)

The Developer API is a read-only, key-authenticated adapter over the app's
existing map-data services, mounted at `/api/v1`. It is additive: every
internal route keeps working unchanged, and the API calls the same exported
service functions the app's own screens call, so behaviour parity with the
internal surface is structural rather than a promise.

This document describes the surface for the people who will use it. The
machine-readable contract lives beside it in
[`docs/openapi.yaml`](openapi.yaml), and the API itself serves that document
at `GET /api/v1/openapi.yaml`.

## What it serves

| Endpoint | Scope | Notes |
|---|---|---|
| `GET /api/v1/capabilities` | any key | Machine-readable capability report: what is available, which provider, the rate limit, the scope list. |
| `GET /api/v1/search` | `search:read` | Place search (`q`, `limit`, `bbox`, `near`, `radius`, `lang`). |
| `GET /api/v1/search/suggest` | `search:read` | Autocomplete suggestions, same parameters. |
| `GET /api/v1/directions` | `routing:read` | Directions (`origin`, `destination`, `waypoints`, `mode`). Served modes only. Costs **3** requests of a key's quota. |
| `GET /api/v1/places` | `places:read` | Place search from the connected place provider. Answers `501 not_configured` while no provider is connected (the deliberate default). |
| `GET /api/v1/places/{id}` | `places:read` | Place details. Also `501` while no provider is connected. |
| `GET /api/v1/community/proposals` | `community:read` | Public community proposals. |
| `GET /api/v1/community/proposals/{id}` | `community:read` | One public proposal. |
| `GET /api/v1/reports` | `reports:read` | Public reports. |
| `GET /api/v1/reports/{id}` | `reports:read` | One public report. |
| `GET /api/v1/openapi.yaml` | any key | The API's own OpenAPI 3.1 document. |

Not available, and not advertised as available: business profiles, transit,
weather, traffic, saved places, trips, location sharing, and writes of any
kind. There is no route and no stub for any of them; `/capabilities` names
them under `notAvailable`.

## Authentication

Every `/api/v1` request carries an API key as a bearer token:

```
Authorization: Bearer hm_live_...
```

Keys belong to a person, not to an app. You create, list and revoke your own
keys on the **Developer API** screen in the app (Profile → Developer API, or
`#/developer-api`). Key management uses your signed-in session, never a key:
an API key that reaches the management surface gets a plain `404`, so a
stolen key can neither list, create nor revoke anything.

Key facts:

- A key is shown **once**, at creation. The server stores only a SHA-256
  hash, so a lost key cannot be recovered; revoke it and create a new one.
- Keys are named (for example "My scripts") so you can tell them apart.
- A person may hold at most **5 active keys** (`API_MAX_KEYS_PER_USER`);
  revoking one frees its slot.
- A key can carry any subset of the read scopes: `search:read`,
  `routing:read`, `places:read`, `community:read`, `reports:read`. New keys
  get all five; a narrower key answers `403 insufficient_scope` outside its
  scopes.

## Rate limits

Each key has its own token bucket: `API_RATE_LIMIT_PER_MINUTE` requests per
minute (default 60), refilled continuously rather than in a burst at the top
of the minute. A directions request costs 3. When a key's bucket is empty the
API answers `429 rate_limited` with a `Retry-After` header giving the seconds
until the next request fits. Respect `Retry-After`; do not retry in a tight
loop.

## Errors

Every failure, on every endpoint, uses one envelope:

```json
{ "error": { "code": "not_found", "message": "That proposal does not exist." } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_query` | 400 | A parameter is missing or malformed. |
| `unsupported_mode` | 400 | The requested travel mode is not served. |
| `missing_key` | 401 | No `Authorization: Bearer` header was sent. |
| `invalid_key` | 401 | The key is not valid. The message is always the same, whether the key was mistyped, revoked or expired, and the API never says which. |
| `insufficient_scope` | 403 | The key lacks the scope this endpoint needs. |
| `not_found` | 404 | Unknown id or unknown endpoint. |
| `no_route` | 404 | The routing provider found no route. |
| `not_configured` | 501 | The endpoint exists but its provider is not connected (places today). |
| `api_disabled` | 503 | The operator switched the API off with `API_ENABLED=0`. |
| `provider_error` | 502 | An upstream provider failed unexpectedly. Safe to retry. |
| `rate_limited` | 429 | The key's quota is spent. Retry after `Retry-After` seconds. |
| `timeout` | 504 | An upstream provider took too long. Safe to retry. |

Authentication failures are uniform on purpose: a `401` never reveals
whether a key exists.

## Attribution and data terms

Search, directions and place data come from OpenStreetMap contributors
(through the configured providers). Every successful response carries an
`attribution` field, currently `© OpenStreetMap contributors`; show it
wherever you display results from the API. The underlying data is licensed
under the ODbL: you may build on it, but you may not resell it as a competing
map dataset. Cache what you fetch — suggestions for minutes, search results
for up to a day, routes for up to ten minutes — and never redistribute in
bulk. The OpenAPI document's description carries the same terms.

## Staging sandbox

Staging previews cannot issue real keys, so the staging database is seeded
with one obviously fake demo key you can use to exercise the API from a
script:

```
hm_live_oB8VgIj2kerTKfTe9fY32GF9moDUKSoXABdexegETcM
```

This key exists **only in staging** (it is inserted by a boot-time seed
gated on `USERNODE_ENV=staging`) and is refused in production like any other
key that was never created there. Its quota and scopes behave exactly like a
real key's.

## Versioning

This is `v1`. Additive changes (new fields in responses, new endpoints) may
appear without notice; clients should ignore fields they do not recognise. A
breaking change would ship as `/api/v2` with `/api/v1` kept alive until the
last consumer moves off.

## Changelog

- **Phase 12K (v1)** — initial surface: capabilities, search, suggestions,
  directions, places (contract wired, `501` without a provider), public
  community proposals and reports, the OpenAPI document, and personal API
  keys with scopes, per-key rate limits and the `API_ENABLED` kill switch.
