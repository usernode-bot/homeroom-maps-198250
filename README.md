# Homeroom Maps

A global map and location platform, built together with its community.

> **Phases 0 to 11 are in place**, except where a phase is explicitly still a
> placeholder. The app shell, theme, shared UI, worldwide place search, the
> Places model/card/detail views, directions and routing, community proposals
> and voting, saved places and lists, navigation, the English/Indonesian i18n
> layer, trip planning and the AI map assistant all work. Still not built, and
> clearly labelled as placeholders: a place-data provider, the remaining
> community tools (contributions, discussions), traffic, transit, offline maps
> and location sharing. `/api/config` reports the configured `mapProvider`
> (the keyless MapLibre/OpenFreeMap default) and `placeProvider: null`: the
> map frame is live, per-place detail enrichment still has no provider, and
> `features.ai` follows the platform LLM proxy (on only when both proxy values
> are present, which production has and staging does not).

## What exists today

- **App shell** with a top bar and a five-tab bottom navigation: Home,
  Discover, Directions, Community, Profile. Tabs are hash routes (`#/`,
  `#/discover`, `#/directions`, `#/community`, `#/profile`), so reload, back
  and forward all work.
- **Theme system.** The app follows the platform's Light/Dark choice (via the
  bridge) or the device when opened standalone, and Profile offers a
  System / Light / Dark override. Colours come from semantic tokens
  (`--hm-*`) mapped into Tailwind, not from hard-coded hex values.
- **Reusable UI components** — button, card, placeholder panel, empty state,
  loading state, error state, top bar, bottom nav, inline icons, and the
  search bar / results panel under `public/js/components/search/`.
- **Global search** — worldwide search for countries, cities, regions,
  streets, addresses, landmarks, places and POIs, with autocomplete,
  suggestions, recent searches and full loading / no-result / error states.
  A provider-agnostic stack (`search/` on the server,
  `public/js/services/search.js` on the client) with Photon (free,
  OpenStreetMap data) as the default provider and implemented adapters for
  Nominatim and Pelias; Mapbox, Google Places and HERE are honest
  placeholders awaiting keys. See `docs/provider-comparison.md` for the full
  evaluation. Recent searches are device-local; nothing is invented: an
  empty answer is the no-results state and a failure is the error state.
  Privacy posture: provider keys never leave the server, `/api/search*` sits
  behind the platform auth gate, and recent searches never leave the device.
  Search queries themselves are necessarily forwarded from the server IP to
  the public geocoder and are not persisted beyond the short-lived in-memory
  cache. Lint checks here are the test suite plus the CSS build (`npm test`,
  `npm run build`); the repo deliberately carries no ESLint config.
- **Community core** — proposals people make about the map (add missing
  place, correct place, update hours, correct location, report wrong
  information, add landmark, suggest map improvement) with a lifecycle of
  Draft, Open, Under Review, Accepted, Rejected and Implemented, and
  upvote/downvote voting. The Community tab has Recent, Popular, Nearby,
  Implemented and Yours views. Rules live in `community/model.js`, Postgres
  access in `community/store.js`, routes (`/api/community/*`) in
  `community/routes.js`. One vote per person per proposal is the votes
  table's primary key; every tally is counted from stored votes on read.
  Authors edit drafts, and open proposals until the first vote; reviewers
  (usernames in the `COMMUNITY_REVIEWERS` secret, empty by default) move
  proposals through review. Moderation, spam prevention, duplicate detection
  and reputation are extension points in `community/policies.js` with
  nothing registered: the app does not claim to do any of them yet.
- **Places (Phase 3)** — a normalized, provider-independent Place model
  (`places/place.js` on the server, `public/js/services/places-model.js` on
  the client), a PlaceService over a PlaceProvider abstraction
  (`places/index.js`), one reusable Place Card, and a Place Detail view on
  the Discover screen reached through the documented Search→Places
  interface. No place-data provider is connected yet (`placeProvider: null`
  from `/api/config`, `PLACE_PROVIDER` unset): every per-place field the
  search data does not carry renders an honest "Not available" state, and
  `/api/places*` answers 501 rather than serving fabricated POI data. The
  SavedPlacesAdapter interface (`public/js/services/saved.js`) is unchanged;
  Phase 7 supplies the real server-backed adapter that implements it.
- **Saved places and lists (Phase 7)** — signed-in people save real places
  from search or the Place Detail view and keep them in lists. Every account
  starts with four built-in lists (Favorites, Want to Visit, Travel,
  Restaurants); custom lists can be created, renamed and deleted, and a place
  can be added to or removed from any list. Rules live in `saved/model.js`,
  Postgres access in `saved/store.js` and routes (`/api/saved/*`) in
  `saved/routes.js`; the Saved screen is the `#/saved` hash route, reachable
  from Profile, and a Save button sits on every Place Detail. A saved place
  references the real place id the search stack gives it: nothing is
  invented, and no second place model exists. Ownership is enforced in every
  query and by a composite owner foreign key, so nobody can read or change
  another person's saved places. Deleting a list removes the list and its
  memberships only; the places themselves stay saved.
- **Profile activity (Phase 7)** — `GET /api/profile` returns the signed-in
  person's own contribution, proposal and vote counts together with their
  saved-place count, read from the existing community tables. The Profile tab
  shows these real numbers; nothing is estimated, and when the request fails
  the card says so instead of showing a number.
- **Environment configuration** in `config.js`, plus `GET /api/config`
  (public, non-sensitive), `GET /api/me` (the signed-in person),
  `GET /api/search`, `GET /api/search/suggest`, `GET /api/places`,
  `GET /api/places/:id`, the community routes under `/api/community/*`, the
  saved-places and profile routes under `/api/saved/*` and `/api/profile`, and
  the assistant routes under `/api/assistant/*`.
- **AI map assistant (Phase 11)** — an "Ask about the map" sheet on Home that
  answers place, route, trip, saved-place and community questions by calling
  read tools over the SAME services their screens use, so every fact in an
  answer is grounded in a real tool result and nothing is invented. The only
  AI path is the platform's LLM proxy, and it is enabled only when BOTH
  `USERNODE_LLM_PROXY_URL` and `USERNODE_LLM_PROXY_TOKEN` are present (both
  platform-injected, neither a third-party key, and staging has neither), so
  `/api/config`'s `features.ai`, `/api/assistant/status.enabled` and the
  surface itself all show an honest disabled state otherwise. `POST
  /api/assistant/turn` returns an answer plus action PROPOSALS;
  `POST /api/assistant/act` validates and normalizes one action and never
  mutates domain data; every write goes through the EXISTING saved-places or
  trips endpoint after an explicit confirmation. Map context is
  client-side-only and non-authoritative. `?assistant=demo` (staging only) is
  a deterministic, read-only canned transcript that calls no proxy, no `/act`
  and no write endpoint. No new table and no migration: the transcript lives
  in memory and nothing is persisted.
- **Error boundary and loading states** — a screen that throws shows the
  shared error state with a Try again action; fetches show a skeleton.
- **Service interfaces** (`public/js/services/*`) with real implementations
  for search, places, routing, navigation, community, saved places, trips and
  the assistant, and
  documented placeholders for the stages that are still unbuilt, so no screen
  can fake map or community behaviour.
- **Tests** — `npm test` runs the whole suite (`node --test`): search,
  places, i18n, routing, navigation, community, saved places and the assistant.
  The Postgres
  suites (community, saved places, profile) need a database:
  `TEST_DATABASE_URL` (or the build worker's `INLOOP_DATABASE_URL`); without
  one they are skipped.

## What is still a placeholder

Map canvas, "Search this area" / "Nearby" controls (the search service
already accepts a map area and a location with a radius; only the
map-anchored UI is missing), points-of-interest browsing from a dedicated
place-data provider, traffic, public transit, offline maps and location
sharing, and the community features after proposals and voting
(contributions, discussions). The Home map frame is live; `/api/config`
reports the configured `mapProvider` and `placeProvider: null`.

## Stack

Node.js + Express server (`server.js`, `config.js`), plain HTML and ES-module
JavaScript frontend (`public/`), Tailwind compiled at image build time from
`styles/tailwind-input.css` and `tailwind.config.js`, and a PostgreSQL
database. Auth is the platform's iframe token injection; there is no separate
login.

## Run it locally

```sh
npm ci --include=dev
npm run build     # compiles public/tailwind.css
npm start
```

The platform conventions are the authoritative reference for how this app
must behave; see `CLAUDE.md`.
