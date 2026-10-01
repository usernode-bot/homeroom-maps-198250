# Homeroom Maps

A global map and location platform, built together with its community.

> **Phase 0 (foundation), Phase 2 (global search) and Phase 3 (Places) are
> in place.** The app shell, navigation, theme, shared UI, worldwide place
> search and the Places model/card/detail views all work. The map,
> directions, navigation, AI and the community tools are not built yet: every
> one of them is a clearly labelled placeholder. Nothing here is a working
> map.

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
- **Places (Phase 3)** — a normalized, provider-independent Place model
  (`places/place.js` on the server, `public/js/services/places-model.js` on
  the client), a PlaceService over a PlaceProvider abstraction
  (`places/index.js`), one reusable Place Card, and a Place Detail view on
  the Discover screen reached through the documented Search→Places
  interface. No place-data provider is connected yet (`placeProvider: null`
  from `/api/config`, `PLACE_PROVIDER` unset): every per-place field the
  search data does not carry renders an honest "Not available" state, and
  `/api/places*` answers 501 rather than serving fabricated POI data. The
  SavedPlacesAdapter interface (`public/js/services/saved.js`) is the same
  kind of placeholder: the contract is defined, no adapter exists, no fake
  saved data.
- **Environment configuration** in `config.js`, plus `GET /api/config`
  (public, non-sensitive), `GET /api/me` (the signed-in person),
  `GET /api/search`, `GET /api/search/suggest`, `GET /api/places` and
  `GET /api/places/:id`.
- **Error boundary and loading states** — a screen that throws shows the
  shared error state with a Try again action; fetches show a skeleton.
- **Service interfaces** for the later stages (`public/js/services/*`),
  documented but not implemented, so no screen can fake map or community
  behaviour.
- **Unit tests** — `npm test` runs the search service's suite (`node --test`).

## What is a placeholder (map phase and later)

Map canvas, "Search this area" / "Nearby" controls (the search service
already accepts a map area and a location with a radius; only the
map-anchored UI is missing), points-of-interest browsing from a dedicated
place-data provider, routing and navigation, traffic, public transit,
offline maps, saved places, trip planning, location sharing, the AI
assistant, and the whole community system (proposals, voting, reports,
contributions, discussions). The Home map frame and the two map controls are
disabled placeholders; `/api/config` reports `mapProvider: null` and
`placeProvider: null`.

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
