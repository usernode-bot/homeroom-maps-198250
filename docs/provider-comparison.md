# Search provider comparison (Phase 2, Global Search)

Why Homeroom Maps searches with **Photon by default** and why the UI is not
locked to it. The search stack (`search/`) separates the UI, the client
service, the HTTP routes and the provider adapters, and every adapter returns
the same normalized result shape (`search/normalize.js`), so switching
providers is a `SEARCH_PROVIDER` config change, never a code change.

## Evaluation

All six providers requested for evaluation, on the criteria that matter for
global search of countries, cities, regions, streets, addresses, landmarks,
places and POIs.

| | Global coverage | Autocomplete/suggest | Typo tolerance | Multilingual names | Licensing | Pricing | Rate limits | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Nominatim** (OSM public instance) | Worldwide OSM data: admin places, streets, addresses, POIs | **Forbidden by usage policy**; must not be implemented via the API | Weak (exact-prefix matching) | `accept-language`; good for major languages | ODbL, attribution required, no reselling of results | Free | Absolute max 1 req/s summed over all users; bulk rules; 403/429/IP bans for violations | **Adapter implemented, not default.** Legitimate fallback for one-off `search` mode only; unusable for the autocomplete UX this change centres on |
| **Photon** (komoot, OSM + OpenSearch) | Same worldwide OSM coverage (planet import, ~95 GB self-hosted) | Built for it (`/api?q=` with typing-scale latency) | Strong fuzzy matching, the best of the free options | `lang` param (de, en, fr, it); local-script names primary otherwise | Open source (Apache/LGPL); public demo server free | Free; self-hosted JAR available | Demo server: no hard published quota, "reasonable use", throttling/bans for extensive use, no SLA | **Default adapter, fully implemented.** Only zero-key, zero-cost option that legitimately does autocomplete with typo tolerance and OSM data matching this app's domain |
| **Pelias** (open source; hosted as Geocode Earth) | Worldwide via Who's on First + OSM + OpenAddresses + Geonames | First-class autocomplete | Strong | Multi-language search and display built in; strongest of the open options | MIT (engine); hosted service commercial | Self-host free; Geocode Earth from ~$100/mo flat (free trial; free/academic plans exist) | Self-host: none imposed | **Adapter implemented, not default.** Self-host needs Elasticsearch + ~64 GB RAM, beyond this app's single Postgres container; becomes the no-lock-in escape hatch if Photon's demo server proves too tight. Hosted Geocode Earth is a config change away |
| **Mapbox** (Geocoding + Search Box) | Worldwide commercial data; POI quality varies by region | Search Box `/suggest` + `/retrieve`, session-based | Good | Localized names in common languages | Proprietary; **permanent geocoding requires a paid SKU**, storing results restricted | Temporary Geocoding: 100k free/mo then ~$0.75/1k; Search Box billed per session (tiered, preview pricing) | Published quotas per plan | **PLACEHOLDER adapter, not configured.** No key exists in `dapp.json`; requires billing and accepting vendor terms. Not justified while a free OSM-based default meets the requirement |
| **Google Places API (New)** | Best-in-class POI/address coverage | Native autocomplete with session tokens | Strong (best-in-class corrections) | Localized into 100+ languages, the strongest here | Proprietary, no result caching rights; attribution required | Autocomplete $2.83/1k after 10k/mo free; sessions priced separately; Place Details $5-25/1k | Standard Google quotas | **PLACEHOLDER adapter, not configured.** Costs money per keystroke at scale, requires a billing account, and locks result usage to Google terms. Documented as the "premium quality" upgrade path |
| **HERE** (Geocoding & Search v7) | Strong worldwide, premium Japan data excluded from one endpoint | `/autocomplete` + Autosuggest | Good | Good international coverage | Proprietary | Freemium: 250k free transactions/mo (plus 250 "assets", i.e. tracked end users) | Per-plan RPS caps | **PLACEHOLDER adapter, not configured.** Generous free tier but needs an account/key and per-selection follow-up transactions; no advantage over the free default for this app's current scale |

## Why Photon as default is not lock-in

Every layer consumes only the normalized shapes; switching providers is a
one-line config change (`SEARCH_PROVIDER`, a `dapp.json` secret, default
`photon`). If Photon's demo server throttles the app's real traffic, the
sanctioned moves are (a) flip to self-hosted Photon or Pelias via
`PHOTON_URL` / `PELIAS_URL`, or (b) fill in one of the commercial adapters
once a key is available through the platform's Secrets UI. No UI or client
code changes in any case.

The only dependency the default creates is on OpenStreetMap data (ODbL:
attribution line under results, no reselling of results), and that dependency
is identical under a self-hosted Nominatim, Photon or Pelias — it does not
change with the adapter.

## Politeness toward the free public endpoints

The public Photon server has no hard published quota; Nominatim's policy caps
the app at an aggregate 1 request per second. Three mechanisms keep the app
inside both policies regardless of user count:

- a server-side token bucket (`search/rate-limit.js`: capacity 5, refill 1/s)
  applied to adapters marked `public`;
- a server-side LRU cache (`search/cache.js`: suggestions 5 min, searches
  24 h, 500 entries);
- a client-side 250 ms debounce with `AbortController`, so typing a long
  query issues one in-flight request, not one per keystroke.

## Sources

- [OSMF Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [Photon on GitHub](https://github.com/komoot/photon/)
- [Photon API docs](https://github.com/komoot/photon/blob/master/docs/api-v1.md)
- [Pelias](https://pelias.io/)
- [Geocode Earth data sources](https://geocode.earth/docs/reference/data_sources)
- [Mapbox pricing](https://www.mapbox.com/pricing/)
- [Mapbox Search Box docs](https://docs.mapbox.com/api/search/search-box/)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [HERE pricing](https://www.here.com/get-started/pricing)
- [HERE Autocomplete docs](https://docs.here.com/geocoding-and-search/docs/autocomplete)