// Tests for the weather session core (public/js/services/weather-core.js) —
// the pure state machine behind the weather panel. The module is import-free
// ESM, so node:test drives it directly via a dynamic import, the same
// convention as tests/traffic-conditions.test.js.
//
// Covered: the capability resolver, centre rounding, the unit formatters,
// staleness, and every honesty rule of the session state machine — no fetch
// and no data state while the capability is unavailable, the generation guard
// that keeps a superseded request from ever settling into the panel, the
// offline shortcut, the refresh throttle, and payload-completeness
// rejection.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let core;

before(async () => {
  core = await import('../public/js/services/weather-core.js');
});

// A session whose fetch is a manually-resolved promise, so a test can hold a
// request in flight, start a newer one, and settle the old one out of order.
function manualSession({ config = null, now, isOnline } = {}) {
  const pending = [];
  const session = core.createWeatherSession({
    now: now || (() => 1_000_000),
    isOnline: isOnline || (() => true),
    fetchCurrent: (center, meta) =>
      new Promise((resolve, reject) => {
        pending.push({ center, meta, resolve, reject });
      }),
  });
  session.setCapability(config);
  session._pending = pending;
  return session;
}

const CAPABLE = { configured: true, provider: 'example-weather', blocker: null, reason: null };
const READABLE = {
  provider: 'example-weather',
  attribution: 'Example Weather',
  observedAt: '2026-10-11T09:30:00.000Z',
  temperatureC: 18.4,
  precipitationMmH: 0.2,
  windSpeedMs: 3.5,
  windDirectionDeg: 240,
  fields: ['temperature', 'precipitation', 'wind'],
};

test('resolveWeatherCapability refuses everything the server does not affirm', () => {
  for (const config of [null, undefined, {}, { configured: false, blocker: 'W1' }, 'nope']) {
    const cap = core.resolveWeatherCapability(config);
    assert.equal(cap.available, false);
    assert.equal(cap.blocker, 'W1');
  }
  const cap = core.resolveWeatherCapability({ configured: true, provider: 'x' });
  assert.equal(cap.available, true);
  assert.equal(cap.blocker, null);
});

test('an unavailable capability fetches nothing, ever, and holds the unavailable state', async () => {
  let fetches = 0;
  const session = core.createWeatherSession({
    fetchCurrent: async () => {
      fetches += 1;
      return READABLE;
    },
  });
  session.setCapability({ configured: false, blocker: 'W1', reason: 'not authorized' });
  await session.request({ lat: 52.5, lng: 13.4 });
  await session.refresh();
  session.movedTo({ lat: 53, lng: 13.5 });
  assert.equal(fetches, 0);
  const state = session.getState();
  assert.equal(state.name, 'unavailable');
  assert.equal(state.reading, null);
  assert.equal(state.capability.available, false);
  assert.equal(state.capability.blocker, 'W1');
});

test('an unavailable capability wipes any reading a previous configuration left', async () => {
  const session = manualSession({ config: CAPABLE });
  const opening = session.request({ lat: 52.5, lng: 13.4 });
  session._pending[0].resolve(READABLE);
  await opening;
  assert.equal(session.getState().name, 'ready');
  // The configuration flips off: the reading is dropped, not kept.
  session.setCapability({ configured: false, blocker: 'W1', reason: 'revoked' });
  const state = session.getState();
  assert.equal(state.name, 'unavailable');
  assert.equal(state.reading, null);
});

test('a superseded request can never settle into the panel (generation guard)', async () => {
  const session = manualSession({ config: CAPABLE });
  const first = session.request({ lat: 52.5, lng: 13.4 });
  const second = session.request({ lat: 52.5, lng: 13.4 });
  assert.equal(session._pending.length, 2);
  // The FIRST request settles late, after the second superseded it.
  session._pending[0].resolve(READABLE);
  await first;
  assert.equal(session.getState().name, 'loading'); // still waiting on the live one
  session._pending[1].resolve(READABLE);
  await second;
  assert.equal(session.getState().name, 'ready');
});

test('a superseded rejection is equally powerless', async () => {
  const session = manualSession({ config: CAPABLE });
  const first = session.request({ lat: 52.5, lng: 13.4 });
  const second = session.request({ lat: 52.5, lng: 13.4 });
  session._pending[0].reject(new Error('late failure'));
  await first;
  assert.equal(session.getState().name, 'loading');
  session._pending[1].resolve(READABLE);
  await second;
  assert.equal(session.getState().name, 'ready');
});

test('a network-shaped failure is the offline state; anything else is error', async () => {
  const session = manualSession({ config: CAPABLE });
  const a = session.request({ lat: 1, lng: 2 });
  session._pending[0].reject(Object.assign(new Error('down'), { code: 'network_error' }));
  await a;
  assert.equal(session.getState().name, 'offline');

  const b = session.request({ lat: 1, lng: 2 });
  session._pending[1].reject(Object.assign(new Error('nope'), { code: 'not_configured' }));
  await b;
  assert.equal(session.getState().name, 'error');
});

test('an offline device produces the offline state without a request', async () => {
  let fetches = 0;
  const session = core.createWeatherSession({
    isOnline: () => false,
    fetchCurrent: async () => {
      fetches += 1;
      return READABLE;
    },
  });
  session.setCapability(CAPABLE);
  await session.request({ lat: 1, lng: 2 });
  assert.equal(fetches, 0);
  assert.equal(session.getState().name, 'offline');
});

test('reconnect routes through a fresh fetch, never a silent replay', async () => {
  let online = false;
  let fetches = 0;
  const session = core.createWeatherSession({
    isOnline: () => online,
    fetchCurrent: async () => {
      fetches += 1;
      return { ...READABLE, observedAt: new Date(Date.now()).toISOString() };
    },
  });
  session.setCapability(CAPABLE);
  await session.request({ lat: 1, lng: 2 });
  assert.equal(session.getState().name, 'offline');
  online = true;
  session.setOnline(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fetches, 1);
  assert.equal(session.getState().name, 'ready');
});

test('a reading older than the stale window is its own state, never current', async () => {
  let nowMs = 10_000_000;
  const session = core.createWeatherSession({
    now: () => nowMs,
    fetchCurrent: async () => READABLE, // observed 09:30 UTC on 2026-10-11
  });
  session.setCapability(CAPABLE);
  // now() sits within an hour of the observation.
  nowMs = Date.parse('2026-10-11T10:00:00.000Z');
  await session.request({ lat: 1, lng: 2 });
  assert.equal(session.getState().name, 'ready');
  session.setCapability({ ...CAPABLE });
  // An hour and a minute later, the same payload arrives: stale, not ready.
  nowMs = Date.parse('2026-10-11T10:31:00.000Z');
  const state = await session.request({ lat: 1, lng: 2 });
  assert.equal(state.name, 'stale');
});

test('isStale treats an unreadable observation time as stale', () => {
  assert.equal(core.isStale('not-a-time', 1_000_000), true);
  assert.equal(core.isStale('2026-10-11T09:30:00Z', Date.parse('2026-10-11T10:00:00Z')), false);
  assert.equal(core.isStale('2026-10-11T09:30:00Z', Date.parse('2026-10-11T11:00:00Z')), true);
});

test('the refresh throttle allows one fetch a minute while a reading is on screen', async () => {
  let nowMs = 1_000_000;
  let fetches = 0;
  const session = core.createWeatherSession({
    now: () => nowMs,
    fetchCurrent: async () => {
      fetches += 1;
      return { ...READABLE, observedAt: new Date(nowMs).toISOString() };
    },
  });
  session.setCapability(CAPABLE);
  await session.request({ lat: 1, lng: 2 });
  assert.equal(fetches, 1);
  nowMs += 10_000;
  await session.refresh(); // throttled
  assert.equal(fetches, 1);
  nowMs += 61_000;
  await session.refresh(); // past the window
  assert.equal(fetches, 2);
});

test('a request without honest coordinates fetches nothing and says so', async () => {
  let fetches = 0;
  const session = core.createWeatherSession({
    fetchCurrent: async () => {
      fetches += 1;
      return READABLE;
    },
  });
  session.setCapability(CAPABLE);
  await session.request(null);
  await session.request({ lat: 'north', lng: 13.4 });
  await session.request({ lat: 95, lng: 13.4 });
  assert.equal(fetches, 0);
  const state = session.getState();
  assert.equal(state.name, 'error');
  assert.equal(state.error, 'no_center');
  assert.equal(state.reading, null);
});

test('a payload missing its attribution or observed time is rejected outright', async () => {
  for (const bad of [
    null,
    'sunny',
    { ...READABLE, attribution: '  ' },
    { ...READABLE, observedAt: 'yesterday-ish' },
    { ...READABLE, provider: '' },
  ]) {
    let fetches = 0;
    const session = core.createWeatherSession({
      fetchCurrent: async () => {
        fetches += 1;
        return bad;
      },
    });
    session.setCapability(CAPABLE);
    await session.request({ lat: 1, lng: 2 });
    const state = session.getState();
    assert.equal(state.name, 'error', JSON.stringify(bad));
    assert.equal(state.reading, null);
    assert.equal(fetches, 1);
  }
});

test('roundCenter keeps the 3-decimal grid and refuses unusable values', () => {
  assert.deepEqual(core.roundCenter(52.512345, 13.41111), { lat: 52.512, lng: 13.411 });
  assert.equal(core.roundCenter('north', 13.4), null);
  assert.equal(core.roundCenter(95, 0), null);
  assert.equal(core.roundCenter(0, 200), null);
});

test('distanceMeters measures the great-circle distance', () => {
  const d = core.distanceMeters({ lat: 52.5, lng: 13.4 }, { lat: 52.5, lng: 13.41 });
  // ~0.01 degrees of longitude at 52.5 N is ~680 m.
  assert.ok(d > 600 && d < 760, `expected ~680 m, got ${d}`);
  assert.equal(core.distanceMeters(null, { lat: 1, lng: 2 }), null);
});

test('the formatters render both unit systems and refuse unusable values', () => {
  assert.equal(core.formatTemperature(18.4, 'metric'), '18°C');
  assert.equal(core.formatTemperature(18.4, 'imperial'), '65°F');
  assert.equal(core.formatTemperature(0, 'metric'), '0°C');
  assert.equal(core.formatTemperature('warm', 'metric'), null);
  assert.equal(core.formatWind(3.5, 'metric'), '13 km/h');
  assert.equal(core.formatWind(3.5, 'imperial'), '8 mph');
  assert.equal(core.formatWind(-1, 'metric'), null);
  assert.equal(core.formatPrecipitation(0.2, 'metric'), '0.2 mm/h');
  assert.equal(core.formatPrecipitation(2.54, 'imperial'), '0.1 in/h');
  assert.equal(core.formatPrecipitation(null, 'metric'), null);
});

test('normalizeWeatherReading keeps only the declared fields, and drops unknown ones', () => {
  const out = core.normalizeWeatherReading({
    ...READABLE,
    humidityPct: 44,
    fields: ['temperature', 'precipitation', 'wind', 'pollen'],
  });
  assert.ok(out.ok);
  assert.deepEqual(out.reading.fields, ['temperature', 'precipitation', 'wind']);
  assert.equal(out.reading.humidityPct, undefined);
  // A field declared without its value is dropped, not rendered as a hole.
  const partial = core.normalizeWeatherReading({
    ...READABLE,
    precipitationMmH: null,
  });
  assert.ok(partial.ok);
  assert.deepEqual(partial.reading.fields, ['temperature', 'wind']);
});

test('listeners hear every state change and an exploding listener breaks nothing', async () => {
  const session = manualSession({ config: CAPABLE });
  const seen = [];
  session.subscribe(() => {
    throw new Error('listener bug');
  });
  session.subscribe((s) => seen.push(s.name));
  const opening = session.request({ lat: 1, lng: 2 });
  session._pending[0].resolve(READABLE);
  await opening;
  assert.ok(seen.includes('loading'));
  assert.ok(seen.includes('ready'));
});
