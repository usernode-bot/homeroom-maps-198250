# Homeroom Maps

A global map and location platform, built together with its community.

> **Phase 0 — Foundation.** The app shell, navigation, theme and shared UI
> are in place. The map, search, directions, navigation, AI and the community
> tools are not built yet: every one of them is a clearly labelled
> placeholder. Nothing here is a working map.

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
  loading state, error state, top bar, bottom nav, inline icons.
- **Environment configuration** in `config.js`, plus `GET /api/config`
  (public, non-sensitive) and `GET /api/me` (the signed-in person).
- **Error boundary and loading states** — a screen that throws shows the
  shared error state with a Try again action; fetches show a skeleton.
- **Service interfaces** for the later stages (`public/js/services/*`),
  documented but not implemented, so no screen can fake map or community
  behaviour.

## What is a placeholder (Phase 1+)

Map, place search, points of interest, routing and navigation, traffic,
public transit, offline maps, saved places, trip planning, location sharing,
the AI assistant, and the whole community system (proposals, voting, reports,
contributions, discussions). The Home map frame and the two map controls are
disabled placeholders; `/api/config` reports `mapProvider: null`.

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
