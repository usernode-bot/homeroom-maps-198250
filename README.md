# Homeroom Maps

A global map and location platform, built together with its community.

> **Phase 0 (foundation), Phase 1 (world map), Phase 2 (global search) and
> Phase 5 (community core: proposals and voting) are in place.** Directions,
> navigation, AI and the rest of the community tools (reports, contributions,
> discussions) are not built yet and are clearly labelled placeholders.

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
- **Environment configuration** in `config.js`, plus `GET /api/config`
  (public, non-sensitive), `GET /api/me` (the signed-in person),
  `GET /api/search` and `GET /api/search/suggest`.
- **Error boundary and loading states** — a screen that throws shows the
  shared error state with a Try again action; fetches show a skeleton.
- **Service interfaces** for the later stages (`public/js/services/*`),
  documented but not implemented, so no screen can fake map or community
  behaviour.
- **Tests** — `npm test` runs the search and community suites
  (`node --test`). The community Postgres tests need a database:
  `TEST_DATABASE_URL` (or the build worker's `INLOOP_DATABASE_URL`); without
  one they are skipped.

## What is a placeholder (map phase and later)

Map canvas, "Search this area" / "Nearby" controls (the search service
already accepts a map area and a location with a radius; only the
map-anchored UI is missing), points-of-interest browsing, routing and
navigation, traffic, public transit, offline maps, saved places, trip
planning, location sharing, the AI assistant, and the community features
after proposals and voting (reports, contributions, discussions). The Home map frame
and the two map controls are disabled placeholders; `/api/config` reports
`mapProvider: null`.

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
