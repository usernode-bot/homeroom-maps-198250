// Tests for locale-aware formatting (public/js/i18n/format.js) — unit
// resolution, distance/number/date rules. Node ships full ICU, so Intl output
// is asserted directly against fixed locales and an explicit UTC timezone,
// which keeps every assertion deterministic.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/js/i18n/format.js');

// ---- unit resolution ----

test("system units follow the device region's convention", async () => {
  const { resolveUnits } = await load();
  assert.equal(resolveUnits('system', 'US'), 'imperial');
  assert.equal(resolveUnits('system', 'en-US'), 'imperial');
  assert.equal(resolveUnits('system', 'LR'), 'imperial');
  assert.equal(resolveUnits('system', 'MM'), 'imperial');
  assert.equal(resolveUnits('system', 'id-ID'), 'metric');
  assert.equal(resolveUnits('system', 'en-GB'), 'metric');
  assert.equal(resolveUnits('system', null), 'metric');
  assert.equal(resolveUnits('system', 'garbage'), 'metric');
});

test('an explicit metric or imperial preference overrides the region', async () => {
  const { resolveUnits } = await load();
  assert.equal(resolveUnits('metric', 'US'), 'metric');
  assert.equal(resolveUnits('imperial', 'id-ID'), 'imperial');
});

test('an unsupported stored unit value resolves like system, never throws', async () => {
  const { resolveUnits } = await load();
  assert.equal(resolveUnits('furlongs', 'US'), 'imperial');
  assert.equal(resolveUnits(null, 'id'), 'metric');
});

// ---- distances ----

test('metric distances: metres below 1 km, kilometres above', async () => {
  const { formatDistance } = await load();
  assert.equal(formatDistance(400, { locale: 'en', units: 'metric' }), '400 m');
  assert.equal(formatDistance(999, { locale: 'en', units: 'metric' }), '999 m');
  assert.equal(formatDistance(1000, { locale: 'en', units: 'metric' }), '1 km');
  assert.equal(formatDistance(1500, { locale: 'en', units: 'metric' }), '1.5 km');
  assert.equal(formatDistance(12345, { locale: 'en', units: 'metric' }), '12 km');
});

test('imperial distances: feet below ⅓ mile, miles above, grouping per locale', async () => {
  const { formatDistance } = await load();
  // 400 m = 1,312 ft (below the ⅓-mile cutoff)
  assert.equal(formatDistance(400, { locale: 'en', units: 'imperial' }), '1,312 ft');
  // 2000 m = 1.2427... mi -> one decimal below ten miles
  assert.equal(formatDistance(2000, { locale: 'en', units: 'imperial' }), '1.2 mi');
  // long distances drop the decimal
  assert.equal(formatDistance(30000, { locale: 'en', units: 'imperial' }), '19 mi');
  // Indonesian groups with dots
  assert.equal(formatDistance(400, { locale: 'id', units: 'imperial' }), '1.312 ft');
});

test('the active unit preference is honored when no explicit units are given', async () => {
  const { setUnitsPreference, formatDistance } = await load();
  setUnitsPreference('imperial', 'id-ID');
  assert.equal(formatDistance(2000, { locale: 'en' }), '1.2 mi');
  setUnitsPreference('metric', 'US');
  assert.equal(formatDistance(2000, { locale: 'en' }), '2 km');
  // system + US region = imperial
  setUnitsPreference('system', 'en-US');
  assert.equal(formatDistance(400, { locale: 'en' }), '1,312 ft');
});

test('unusable distance input renders empty, never NaN', async () => {
  const { formatDistance } = await load();
  assert.equal(formatDistance(undefined, { locale: 'en', units: 'metric' }), '');
  assert.equal(formatDistance(-5, { locale: 'en', units: 'metric' }), '');
});

// ---- numbers and percentages ----

test('numbers and percentages follow locale separators', async () => {
  const { formatNumber, formatPercent } = await load();
  assert.equal(formatNumber(12345.6, { locale: 'en' }), '12,345.6');
  assert.equal(formatNumber(12345.6, { locale: 'id' }), '12.345,6');
  assert.equal(formatPercent(0.25, { locale: 'en' }), '25%');
  assert.equal(formatPercent(0.25, { locale: 'id' }), '25%');
  assert.equal(formatPercent(0.1234, { locale: 'en', maximumFractionDigits: 1 }), '12.3%');
  assert.equal(formatNumber('not a number', { locale: 'en' }), '');
});

// ---- dates, times, timezones ----

const FIXTURE = new Date('2026-01-15T13:45:00Z');

test('dates and times format in the requested timezone', async () => {
  const { formatDate, formatTime } = await load();
  const en = formatDate(FIXTURE, { locale: 'en', timeZone: 'UTC' });
  assert.match(en, /2026/);
  assert.match(en, /Jan/);
  const time = formatTime(FIXTURE, { locale: 'en', timeZone: 'UTC' });
  assert.match(time, /1:45|13:45/);
  // same instant, Indonesian conventions
  const id = formatDate(FIXTURE, { locale: 'id', timeZone: 'UTC' });
  assert.match(id, /2026/);
});

test('an unavailable timezone falls back to UTC instead of throwing', async () => {
  const { formatTime } = await load();
  const out = formatTime(FIXTURE, { locale: 'en', timeZone: 'Mars/Olympus' });
  assert.match(out, /UTC/);
});

test('unusable dates render empty, never an error', async () => {
  const { formatDate } = await load();
  assert.equal(formatDate(new Date('not a date'), { locale: 'en' }), '');
  assert.equal(formatDate('garbage', { locale: 'en' }), '');
});

// ---- relative time ----

test('relative time picks the best unit and respects direction', async () => {
  const { formatRelative } = await load();
  const now = new Date('2026-01-15T13:45:00Z');
  assert.equal(formatRelative(new Date('2026-01-18T13:45:00Z'), { locale: 'en', now }), 'in 3 days');
  assert.equal(formatRelative(new Date('2026-01-15T11:45:00Z'), { locale: 'en', now }), '2 hours ago');
  assert.equal(formatRelative(new Date('2026-01-15T13:44:30Z'), { locale: 'en', now }), '30 seconds ago');
});
