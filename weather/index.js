// Weather service — the server-side WeatherService (Phase 12G).
//
// One entry point, run(params), that the HTTP route calls. The pipeline per
// call is, in order:
//
//   validate -> resolve adapter -> W1 rights gate -> configure checks
//            -> rate limit -> cache -> provider adapter -> normalize
//            -> { provider, ..., cached }
//
// Typed errors (weather/provider.js) propagate to server.js, which maps each
// code to its HTTP status; the client's typed ApiError handling picks the
// messages up unchanged. This module owns no provider-specific knowledge,
// and the registry it reads from is deliberately empty — see
// weather/provider.js. There is no fallback path that invents weather.
'use strict';

const { WEATHER_PROVIDER } = require('../config');
const { getProvider, weatherError } = require('./provider');
const { resolveWeatherProviderRights } = require('./provider-policy');
const { TokenBucket } = require('../search/rate-limit');
const { SearchCache } = require('../search/cache');

// Current conditions are cheap to refetch and go stale fast, so the TTL is
// far shorter than search's committed-search day: ten minutes per point.
const WEATHER_TTL_MS = 10 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 8 * 1000;

// The same aggregate-politeness bucket shape search uses. Only authorized
// providers ever reach it, but the shape is here so an adapter does not have
// to be polite to be correct.
function defaultBucket() {
  return new TokenBucket({ capacity: 5, refillPerSecond: 1 });
}

// Coordinates are rounded to 3 decimals (~110 m at the equator) by
// parseCoord, so nearby map pans share one cache entry instead of one per
// float.
function parseCoord(value, { min, max, label }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw weatherError('invalid_request', `A valid ${label} between ${min} and ${max} is required.`);
  }
  return Number(n.toFixed(3));
}

function parseLang(lang) {
  if (lang == null) return null;
  const s = String(lang).trim();
  if (!s) return null;
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(s)) {
    throw weatherError('invalid_request', 'The lang parameter must be a BCP-47 language tag.');
  }
  return s;
}

// The declared condition fields of the normalized WeatherCurrent payload.
// A field is listed ONLY when its provider actually supplied a usable value;
// the panel renders exactly these rows and nothing else.
const WEATHER_FIELD_KEYS = ['temperature', 'precipitation', 'wind'];

function normalizeCurrent(raw, providerName, fetchedAt) {
  if (!raw || typeof raw !== 'object') {
    throw weatherError('provider_error', 'The weather provider sent an answer without data.');
  }
  // The registry identity is the service's own: the response always reports
  // the adapter the pipeline resolved, whatever the raw payload claims.
  const provider = providerName;
  const attribution =
    typeof raw.attribution === 'string' && raw.attribution.trim() ? raw.attribution.trim() : null;
  if (!attribution) {
    throw weatherError('provider_error', 'The weather provider sent an answer without its required attribution.');
  }
  // Coordinates are stamped by run() from the request itself, so a payload
  // without them is still normalizable; a payload with nonsense ones is not
  // trusted.
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);

  let observedAt = null;
  let observedAtEstimated = false;
  if (typeof raw.observedAt === 'string' && Number.isFinite(Date.parse(raw.observedAt))) {
    observedAt = new Date(raw.observedAt).toISOString();
  } else {
    // The provider said nothing about when the reading was taken. Stamp the
    // fetch time and say so, so the panel labels it "Updated" rather than
    // pretending to know an observation moment.
    observedAt = fetchedAt;
    observedAtEstimated = true;
  }

  const out = {
    provider,
    attribution,
    observedAt,
    observedAtEstimated,
    fields: [],
  };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    out.latitude = latitude;
    out.longitude = longitude;
  }
  // A field counts as supplied only when the payload carries an actual
  // value: null, undefined and empty strings are absent, while a real 0 is
  // a genuine reading.
  const has = (key) =>
    raw[key] != null && raw[key] !== '' && Number.isFinite(Number(raw[key]));
  if (raw.fields != null && !Array.isArray(raw.fields)) {
    throw weatherError('provider_error', 'The weather provider sent an unreadable field list.');
  }
  const declared = Array.isArray(raw.fields) && raw.fields.length
    ? raw.fields
    : WEATHER_FIELD_KEYS.filter((key) => {
        if (key === 'temperature') return has('temperatureC');
        if (key === 'precipitation') return has('precipitationMmH');
        if (key === 'wind') return has('windSpeedMs');
        return false;
      });
  for (const key of declared) {
    if (!WEATHER_FIELD_KEYS.includes(key)) continue;
    if (key === 'temperature' && has('temperatureC')) {
      out.temperatureC = Number(raw.temperatureC);
      out.fields.push('temperature');
    }
    if (key === 'precipitation' && has('precipitationMmH')) {
      out.precipitationMmH = Number(raw.precipitationMmH);
      out.fields.push('precipitation');
    }
    if (key === 'wind' && has('windSpeedMs')) {
      out.windSpeedMs = Number(raw.windSpeedMs);
      out.fields.push('wind');
      if (has('windDirectionDeg')) out.windDirectionDeg = Number(raw.windDirectionDeg);
    }
  }
  if (!out.fields.length) {
    throw weatherError('provider_error', 'The weather provider sent an answer without any usable weather field.');
  }
  if (typeof raw.condition === 'string' && raw.condition.trim()) {
    out.condition = raw.condition.trim();
  }
  return out;
}

// Build a service instance. Every collaborator is injectable so tests never
// touch the network, the real clock or a shared bucket; the module-level
// `service` below is what the HTTP route uses.
function createWeatherService({
  providerName = WEATHER_PROVIDER,
  ttlMs = WEATHER_TTL_MS,
  timeoutMs = WEATHER_TIMEOUT_MS,
  cache = new SearchCache({ maxEntries: 500 }),
  bucket = defaultBucket(),
  resolveRights = resolveWeatherProviderRights,
} = {}) {
  // The W1 gate is evaluated once per provider name per process: it reads a
  // committed documentation file, not a network state, so caching it changes
  // nothing an operator could flip mid-flight without a redeploy.
  let rights = null;
  let rightsFor = null;
  function rightsForProvider(name) {
    if (rightsFor !== name) {
      rights = resolveRights(name);
      rightsFor = name;
    }
    return rights;
  }

  async function run(params, opts = {}) {
    const lat = parseCoord(params && params.lat, { min: -90, max: 90, label: 'latitude' });
    const lng = parseCoord(params && params.lng, { min: -180, max: 180, label: 'longitude' });
    const lang = parseLang(params && params.lang);

    const name = opts.providerName || providerName;
    // The rights gate runs before the registry lookup on purpose: an
    // operator naming a provider that no rights document authorizes gets the
    // authorization refusal, not a bare "unknown provider".
    const rights2 = rightsForProvider(name);
    if (!rights2.permitted) {
      throw weatherError(
        'not_configured',
        `Weather is unavailable: ${rights2.reason} See docs/weather-provider-rights.md.`,
      );
    }
    const provider = getProvider(name);
    if (!provider.isConfigured()) {
      throw weatherError('not_configured', `The ${provider.name} weather provider is not configured yet.`);
    }

    // Politeness first, per the pipeline order (mirror of search/index.js).
    if (!bucket.tryTake()) {
      throw weatherError('rate_limited', 'Weather is busy right now. Try again in a moment.');
    }

    const cacheKey = ['weather', provider.name, lat, lng, lang || ''].join('|');
    const cached = cache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    const fetchedAt = new Date().toISOString();
    const raw = await provider.current({ lat, lng, lang, timeoutMs });
    const reading = normalizeCurrent(raw, provider.name, fetchedAt);
    // The answered point is the request's own, rounded exactly as it was
    // asked for, so the panel's caption and the cache key agree.
    reading.latitude = lat;
    reading.longitude = lng;
    cache.set(cacheKey, reading, ttlMs);
    return { ...reading, cached: false };
  }

  // The provider name to report in /api/config: the configured active
  // adapter, or null (mirroring searchProvider/placeProvider while their
  // active adapters are placeholders). With the registry empty this is
  // always null, which is what makes the config block say configured: false.
  function activeProviderName() {
    try {
      const provider = getProvider(providerName);
      return provider.isConfigured() ? provider.name : null;
    } catch {
      return null;
    }
  }

  function capability() {
    const rights2 = rightsForProvider(providerName);
    let providerConfigured = false;
    try {
      providerConfigured = Boolean(getProvider(providerName).isConfigured());
    } catch {
      providerConfigured = false;
    }
    // The effective truth: a provider is usable only when the W1 gate says
    // yes AND its adapter says it is configured. Either half missing is the
    // honest configured: false, with the gate's reason explaining why.
    const configured = Boolean(rights2.permitted && providerConfigured);
    return {
      configured,
      provider: configured ? providerName : null,
      blocker: rights2.blocker,
      reason: rights2.reason,
    };
  }

  return { run, activeProviderName, capability, cache };
}

const service = createWeatherService();

module.exports = {
  run: (params, opts) => service.run(params, opts),
  activeProviderName: () => service.activeProviderName(),
  capability: () => service.capability(),
  createWeatherService,
  WEATHER_FIELD_KEYS,
  normalizeCurrent,
};
