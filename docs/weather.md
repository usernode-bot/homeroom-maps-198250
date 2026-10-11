# Weather (Phase 12G)

Current weather conditions for the map area on screen, reached from the
Weather control on the live map.

The feature ships in an **honest unavailable state**: no weather provider is
implemented, and no weather source is documented as authorized for this
repository. The panel says so plainly ("Weather unavailable") and the
`/api/weather/current` endpoint answers `501 not_configured`. Nothing in the
app displays made-up weather, and there is no path that could: the provider
registry is empty, the `WEATHER_PROVIDER` env var has no default, and a name
alone does not unlock anything (see the W1 gate below).

## Using it

- Tap the cloud button in the map's control column. The panel opens over the
  map and reports one of six states:

| State | When | What it shows |
|---|---|---|
| `unavailable` | No authorized provider (the shipped state) | A notice card and a Check again action. No request is ever made. |
| `loading` | A request is in flight | A spinner. Nothing numeric appears yet. |
| `ready` | A fresh reading | Field rows (temperature, precipitation, wind), the observation time, the source, and a Refresh action. |
| `stale` | The reading is older than one hour | The same reading, labelled as old, with Refresh emphasized. An old reading is never presented as current. |
| `offline` | The device has no connection | A notice card. No request was made; reconnecting triggers a fresh fetch automatically. |
| `error` | The server or the payload failed | A notice card and a retry. A payload missing its provider, attribution or observed time is an error, never a reading with holes. |

- The scope caption ("Current conditions for the map area on screen.") is
  always present, so the reading is never mistaken for a forecast or for
  another place's weather.
- Readings render in the viewer's unit preference (metric by default;
  imperial for US, LR and MM regions, the same rule the rest of the app uses).
- The panel can be deep-linked with `/#/?weather=open` (plus `&lang=id` for
  Indonesian), the same convention as the assistant's `?assistant=` link.

## Server contract

`GET /api/weather/current?lat=<lat>&lng=<lng>[&lang=<tag>]` returns the
normalized `WeatherCurrent` payload:

```json
{
  "provider": "adapter-registry-name",
  "attribution": "String the panel must show as the source",
  "latitude": 52.512, "longitude": 13.411,
  "observedAt": "2026-10-11T09:30:00.000Z",
  "observedAtEstimated": false,
  "temperatureC": 18.4, "precipitationMmH": 0.2,
  "windSpeedMs": 3.5, "windDirectionDeg": 240,
  "condition": "Partly cloudy",
  "fields": ["temperature", "precipitation", "wind"],
  "cached": false
}
```

- `fields` lists exactly which condition fields the provider actually
  supplied; the panel renders exactly those rows and nothing else.
- `observedAtEstimated` is true when the provider said nothing about when the
  reading was taken and the server stamped the fetch time; the panel then
  labels it "Updated at" instead of "Observed at".
- Pipeline order (`weather/index.js`): validate -> resolve adapter -> W1
  rights gate -> configure checks -> rate limit -> cache -> adapter ->
  normalize. Coordinates are rounded to 3 decimals (~110 m) before the
  adapter and the cache key see them. The per-point cache TTL is 10 minutes.
- Typed error codes map to statuses in `server.js`: `invalid_request` 400,
  `not_configured` 501, `rate_limited` 429, `timeout` 504 (weather is
  time-sensitive, so "no answer in time" is its own state), anything else
  502. Payloads are rejected outright unless they carry a real attribution
  and at least one real field value.
- `/api/config` carries a `weather` block
  (`{ configured, provider, blocker, reason }`) and a `features.weather`
  flag that mirror it, so every surface reads one truth.

## The W1 authorization gate

The sibling of the offline feature's B2 tile-download gate
(`docs/offline-search.md` documents that one). A provider may serve live
weather only when `docs/weather-provider-rights.md` commits, at the top
level:

```
provider: <name>
live-data: authorized
evidence: <url or note naming where the right comes from>
```

All three markers must be present and must agree; prose elsewhere in the
document cannot authorize anything. The gate lives in
`weather/provider-policy.js` and is covered by `tests/weather-policy.test.js`.
The full unlock, when it comes, is one change that: commits the rights
document, implements the adapter in `weather/providers/`, registers it,
declares its API key in `dapp.json` per the platform secrets convention, and
lets the existing pipeline, config block and panel states do the rest. No
client change should be needed.

## Files

- `weather/provider-policy.js` — the W1 gate
- `weather/provider.js` — the WeatherProvider contract, the (empty) registry
  and the outbound-request helper
- `weather/index.js` — the pipeline: validation, gate, bucket, cache,
  `normalizeCurrent`
- `weather/server-config.js` — the `/api/config` weather block
- `public/js/services/weather-core.js` — the pure session state machine,
  formatters and payload checks
- `public/js/services/weather.js` — the browser wrapper: real fetch, aborts,
  online/offline events
- `public/js/components/weather/weather-panel.js` — the panel view
- `public/js/map/controls.js`, `public/js/map/icons.js` — the Weather control
- `public/js/screens/home.js` — wiring and the `?weather=open` deep link

## Tests

- `tests/weather-policy.test.js` — the gate's accept/refuse matrix
- `tests/weather-service.test.js` — the pipeline: honesty when the registry
  is empty, gate refusals, validation, cache TTL, payload rejection, the
  normalized shape
- `tests/weather-core.test.js` — the state machine: no-fetch-when-
  unavailable, the generation guard, offline shortcut and reconnect, the
  throttle, staleness, completeness rejection, formatters
- `tests/weather.i18n.test.js` — en/id parity, the verbatim word table, the
  no-em-dash rule
