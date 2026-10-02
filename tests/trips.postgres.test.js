// Trip store and routes against a REAL Postgres database.
//
// Mirrors community.postgres.test.js: each run creates its own throwaway
// schema, applies the boot migration and drives the actual HTTP routes
// (trips/routes.js over trips/store.js) with an express app whose only
// stand-in is the identity — a header names the signed-in person, as the
// platform token would. Nothing in the code under test is stubbed.
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL (the build
// worker's local Postgres). Skipped, loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createStore } = require('../trips/store');
const { createTripsRouter } = require('../trips/routes');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

let pool;
let server;
let base;
const schema = `trips_test_${process.pid}_${Date.now()}`;

const USERS = {
  alice: { id: 101, username: 'alice' },
  bob: { id: 102, username: 'bob' },
  carol: { id: 103, username: 'carol' },
};

async function call(method, path, { as = 'alice', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function tripBody(overrides = {}) {
  return {
    name: 'Jakarta Weekend',
    destination: { name: 'Jakarta', lat: -6.2088, lng: 106.8456 },
    startDate: '2026-06-13',
    endDate: '2026-06-14',
    ...overrides,
  };
}

function itemBody(overrides = {}) {
  return {
    placeId: 'node/123',
    placeSnapshot: {
      name: 'National Museum',
      address: 'Jl. Medan Merdeka Barat',
      coordinates: { lat: -6.176, lng: 106.8215 },
    },
    startTime: '09:30',
    durationMinutes: 120,
    ...overrides,
  };
}

test.before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  const store = createStore({ pool });
  await store.migrate();
  await store.migrate(); // the boot migration must be idempotent
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[req.headers['x-test-user']];
    next();
  });
  app.use('/api/trips', createTripsRouter({ store, isStaging: false }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/trips`;
});

test.after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('an empty list is an empty array, not an error', { skip }, async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
});

test('create generates one day per date, in order', { skip }, async () => {
  const created = await call('POST', '/', { body: tripBody({ startDate: '2026-06-13', endDate: '2026-06-15' }) });
  assert.equal(created.status, 200);
  const trip = created.body;
  assert.equal(trip.name, 'Jakarta Weekend');
  assert.deepEqual(trip.days.map((d) => d.date), ['2026-06-13', '2026-06-14', '2026-06-15']);
  assert.deepEqual(trip.days.map((d) => d.position), [0, 1, 2]);
  assert.ok(trip.days.every((d) => d.items.length === 0));
});

test('validation errors name each field', { skip }, async () => {
  const bad = await call('POST', '/', { body: { name: '', startDate: '2026-06-14', endDate: '2026-06-13' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_trip');
  assert.ok(bad.body.error.fields.name);
  assert.ok(bad.body.error.fields.dates);

  const tooLong = await call('POST', '/', { body: tripBody({ startDate: '2026-01-01', endDate: '2026-04-01' }) });
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.body.error.fields.dates);
});

test('add, reorder within a day, move between days, and remove', { skip }, async () => {
  let trip = (await call('POST', '/', { body: tripBody() })).body;
  const [day1, day2] = trip.days;

  const added1 = await call('POST', `/${trip.id}/days/${day1.id}/items`, { body: itemBody() });
  assert.equal(added1.status, 200);
  const added2 = await call('POST', `/${trip.id}/days/${day1.id}/items`, {
    body: itemBody({ placeId: 'node/456', placeSnapshot: { name: 'Monas' }, startTime: '12:00', durationMinutes: null }),
  });
  trip = added2.body;
  assert.deepEqual(trip.days[0].items.map((i) => i.position), [0, 1]);

  // Reworking the item order: move the second stop to the front.
  const second = trip.days[0].items[1];
  const moved = await call('POST', `/${trip.id}/items/${second.id}/move`, {
    body: { dayId: day1.id, index: 0 },
  });
  trip = moved.body;
  assert.deepEqual(trip.days[0].items.map((i) => i.place.name), ['Monas', 'National Museum']);
  assert.deepEqual(trip.days[0].items.map((i) => i.position), [0, 1]);

  // Move the first stop into day 2, clamped into range.
  const first = trip.days[0].items[0];
  const cross = await call('POST', `/${trip.id}/items/${first.id}/move`, {
    body: { dayId: day2.id, index: 99 },
  });
  trip = cross.body;
  assert.deepEqual(trip.days[0].items.map((i) => i.place.name), ['National Museum']);
  assert.deepEqual(trip.days[1].items.map((i) => i.place.name), ['Monas']);
  assert.deepEqual(trip.days[1].items.map((i) => i.position), [0]);

  // Removing renumbers the remaining stops with no gap.
  const remaining = trip.days[0].items[0];
  const removed = await call('DELETE', `/${trip.id}/items/${remaining.id}`);
  trip = removed.body;
  assert.deepEqual(trip.days[0].items, []);
});

test('a date edit that would drop a populated day is refused', { skip }, async () => {
  let trip = (await call('POST', '/', { body: tripBody({ startDate: '2026-06-13', endDate: '2026-06-15' }) })).body;
  const day2 = trip.days[1];
  trip = (await call('POST', `/${trip.id}/days/${day2.id}/items`, { body: itemBody() })).body;

  const refused = await call('PATCH', `/${trip.id}`, { body: { endDate: '2026-06-13' } });
  assert.equal(refused.status, 409);
  assert.ok(refused.body.error.fields.dates);

  // Shrinking to a range that keeps the populated day succeeds and drops
  // only the empty trailing day.
  const ok = await call('PATCH', `/${trip.id}`, { body: { endDate: '2026-06-14' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.days.map((d) => d.date), ['2026-06-13', '2026-06-14']);

  // Growing the range adds the new day at the end.
  const grown = await call('PATCH', `/${trip.id}`, { body: { endDate: '2026-06-16' } });
  assert.equal(grown.status, 200);
  assert.deepEqual(grown.body.days.map((d) => d.date), ['2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16']);
});

test('ownership isolation: another user cannot see or touch the trip', { skip }, async () => {
  const trip = (await call('POST', '/', { body: tripBody() })).body;
  const day = trip.days[0];
  const withItem = await call('POST', `/${trip.id}/days/${day.id}/items`, { body: itemBody() });
  const itemId = withItem.body.days[0].items[0].id;

  // Bob sees nothing.
  assert.deepEqual((await call('GET', '/', { as: 'bob' })).body.items, []);
  assert.equal((await call('GET', `/${trip.id}`, { as: 'bob' })).status, 404);
  assert.equal((await call('PATCH', `/${trip.id}`, { as: 'bob', body: { name: 'Hijacked' } })).status, 404);
  assert.equal((await call('DELETE', `/${trip.id}`, { as: 'bob' })).status, 404);
  assert.equal((await call('POST', `/${trip.id}/days/${day.id}/items`, { as: 'bob', body: itemBody() })).status, 404);
  assert.equal((await call('POST', `/${trip.id}/items/${itemId}/move`, { as: 'bob', body: { dayId: day.id, index: 0 } })).status, 404);
  assert.equal((await call('DELETE', `/${trip.id}/items/${itemId}`, { as: 'bob' })).status, 404);

  // The owner still sees it and its item is untouched.
  const mine = await call('GET', `/${trip.id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.days[0].items.length, 1);
  assert.equal(mine.body.name, 'Jakarta Weekend');
});

test('unknown and malformed ids are 404s', { skip }, async () => {
  assert.equal((await call('GET', '/999999999')).status, 404);
  assert.equal((await call('GET', '/abc')).status, 404);
  assert.equal((await call('PATCH', '/abc', { body: { name: 'x' } })).status, 404);
  assert.equal((await call('DELETE', '/abc')).status, 404);
  assert.equal((await call('POST', '/abc/days/xyz/items', { body: itemBody() })).status, 404);
});

test('staging seed is idempotent and never involves the visitor', { skip }, async () => {
  const store = createStore({ pool });
  await store.seedStaging();
  await store.seedStaging();
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM trips WHERE id = 900001');
  assert.equal(rows[0].n, 1);
  const days = await pool.query('SELECT count(*)::int AS n FROM trip_days WHERE trip_id = 900001');
  assert.equal(days.rows[0].n, 2);
  const items = await pool.query(
    'SELECT count(*)::int AS n FROM trip_items i JOIN trip_days d ON d.id = i.trip_day_id WHERE d.trip_id = 900001',
  );
  assert.equal(items.rows[0].n, 4);

  // The visitor's own list stays empty: the seed belongs to a fake identity.
  assert.deepEqual((await call('GET', '/', { as: 'carol' })).body.items, []);

  // The demo read works and is marked demo (the route only serves this when
  // isStaging is true; the store itself is what this asserts).
  const demo = await store.getDemo();
  assert.equal(demo.demo, true);
  assert.equal(demo.days.length, 2);
  assert.equal(demo.days.reduce((n, d) => n + d.items.length, 0), 4);
});
