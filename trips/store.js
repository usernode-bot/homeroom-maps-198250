// Trip store — the trip/day/itinerary schema and every query behind it.
//
// The rules come from model.js; this module only enforces them against the
// database, inside transactions, so a rule can never be bypassed by a race.
// Ownership is a database fact: every read and write is scoped by
// trips.owner_id, and a trip, day or item belonging to another person is
// reported as not_found (404) so existence is never leaked.
//
// Day generation and item `position` renumbering happen inside the same
// transaction as the write that caused them, so order is a database fact.
// All three tables are staging:private (they hold named people's travel
// plans), so staging starts with them empty and seedStaging() fills in
// obviously fake rows owned by a fake identity.
'use strict';

const model = require('./model');
const { TripError } = model;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trips (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  name TEXT NOT NULL,
  destination_name TEXT,
  destination_lat DOUBLE PRECISION,
  destination_lng DOUBLE PRECISION,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK ((destination_lat IS NULL) = (destination_lng IS NULL))
);
CREATE INDEX IF NOT EXISTS trips_owner_idx ON trips (owner_id, start_date DESC);
COMMENT ON TABLE trips IS 'staging:private';

CREATE TABLE IF NOT EXISTS trip_days (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_date DATE NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (trip_id, position),
  UNIQUE (trip_id, day_date)
);
CREATE INDEX IF NOT EXISTS trip_days_trip_idx ON trip_days (trip_id, position);
COMMENT ON TABLE trip_days IS 'staging:private';

CREATE TABLE IF NOT EXISTS trip_items (
  id BIGSERIAL PRIMARY KEY,
  trip_day_id BIGINT NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,
  place_snapshot JSONB,
  position INTEGER NOT NULL,
  start_time TEXT,
  duration_minutes INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_day_id, position),
  CHECK (duration_minutes IS NULL OR (duration_minutes > 0 AND duration_minutes <= 1440))
);
CREATE INDEX IF NOT EXISTS trip_items_day_idx ON trip_items (trip_day_id, position);
COMMENT ON TABLE trip_items IS 'staging:private';
`;

// The demo trip's fixed ids, so the staging seed is idempotent and the
// visitor's own list stays honestly empty.
const DEMO_TRIP_ID = 900001;
const DEMO_OWNER = 'staging-demo-user';

function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// A DATE column arrives from pg as a JS Date at UTC midnight; render it back
// as a plain calendar day, never a timestamp.
function isoDay(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function destinationOf(row) {
  if (row.destination_name == null) return null;
  return {
    name: row.destination_name,
    lat: row.destination_lat == null ? null : Number(row.destination_lat),
    lng: row.destination_lng == null ? null : Number(row.destination_lng),
  };
}

function itemApi(row) {
  return {
    id: String(row.id),
    placeId: row.place_id,
    place: row.place_snapshot || null,
    position: Number(row.position),
    startTime: row.start_time || null,
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    notes: row.notes || null,
    createdAt: iso(row.created_at),
  };
}

function tripSummary(row) {
  return {
    id: String(row.id),
    name: row.name,
    destination: destinationOf(row),
    startDate: isoDay(row.start_date),
    endDate: isoDay(row.end_date),
    dayCount: row.day_count == null ? undefined : Number(row.day_count),
    itemCount: row.item_count == null ? undefined : Number(row.item_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function createStore({ pool }) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function migrate() {
    await pool.query(SCHEMA_SQL);
  }

  const notFound = () => new TripError('not_found', 'That trip does not exist.', { status: 404 });

  // Lock the trip row for the rest of the transaction and confirm the viewer
  // owns it. Every write goes through here, so no path can mutate another
  // person's day or item.
  async function lockTrip(client, viewer, id) {
    const { rows } = await client.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0] || String(rows[0].owner_id) !== String(viewer.id)) throw notFound();
    return rows[0];
  }

  async function readDay(client, tripId, dayId) {
    const { rows } = await client.query(
      'SELECT * FROM trip_days WHERE id = $1 AND trip_id = $2',
      [dayId, tripId],
    );
    if (!rows[0]) throw new TripError('not_found', 'That day does not exist.', { status: 404 });
    return rows[0];
  }

  async function orderedItems(client, dayId) {
    const { rows } = await client.query(
      'SELECT * FROM trip_items WHERE trip_day_id = $1 ORDER BY position, id',
      [dayId],
    );
    return rows;
  }

  // Rewrite one day's positions to 0..n-1 in the given id order. The negative
  // shift first keeps the (trip_day_id, position) unique constraint satisfied
  // while the rows move.
  async function setOrder(client, dayId, orderedIds) {
    await client.query('UPDATE trip_items SET position = -1 - position WHERE trip_day_id = $1', [dayId]);
    for (let i = 0; i < orderedIds.length; i += 1) {
      await client.query(
        'UPDATE trip_items SET position = $2 WHERE id = $1 AND trip_day_id = $3',
        [orderedIds[i], i, dayId],
      );
    }
  }

  async function loadDetail(db, viewer, id, { demo = false } = {}) {
    const { rows } = await db.query(
      `SELECT t.*,
              (SELECT count(*) FROM trip_days d WHERE d.trip_id = t.id)::int AS day_count,
              (SELECT count(*) FROM trip_items i
                 JOIN trip_days d ON d.id = i.trip_day_id WHERE d.trip_id = t.id)::int AS item_count
         FROM trips t WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw notFound();
    if (!demo && String(row.owner_id) !== String(viewer.id)) throw notFound();

    const { rows: dayRows } = await db.query(
      'SELECT * FROM trip_days WHERE trip_id = $1 ORDER BY position, id',
      [id],
    );
    const { rows: itemRows } = dayRows.length
      ? await db.query(
          `SELECT * FROM trip_items WHERE trip_day_id = ANY($1::bigint[]) ORDER BY position, id`,
          [dayRows.map((d) => d.id)],
        )
      : { rows: [] };

    const byDay = new Map(dayRows.map((d) => [String(d.id), []]));
    for (const item of itemRows) byDay.get(String(item.trip_day_id)).push(itemApi(item));

    return {
      ...tripSummary(row),
      ...(demo ? { demo: true } : {}),
      days: dayRows.map((d) => ({
        id: String(d.id),
        date: isoDay(d.day_date),
        position: Number(d.position),
        items: byDay.get(String(d.id)) || [],
      })),
    };
  }

  async function list(viewer) {
    const { rows } = await pool.query(
      `SELECT t.*,
              (SELECT count(*) FROM trip_days d WHERE d.trip_id = t.id)::int AS day_count,
              (SELECT count(*) FROM trip_items i
                 JOIN trip_days d ON d.id = i.trip_day_id WHERE d.trip_id = t.id)::int AS item_count
         FROM trips t WHERE t.owner_id = $1 ORDER BY t.start_date DESC, t.id DESC`,
      [viewer.id],
    );
    return { items: rows.map(tripSummary) };
  }

  async function get(viewer, rawId) {
    const id = model.parseTripId(rawId);
    return loadDetail(pool, viewer, id);
  }

  // The staging demo trip, read-only, owned by the fake identity. The route
  // only reaches this behind the IS_STAGING && ?demo=1 gate.
  async function getDemo() {
    try {
      return await loadDetail(pool, null, String(DEMO_TRIP_ID), { demo: true });
    } catch (err) {
      if (err instanceof TripError && err.status === 404) return null;
      throw err;
    }
  }

  async function create(viewer, body) {
    const draft = model.validateTrip(body);
    const dates = model.expandDays(draft.startDate, draft.endDate);
    if (!dates.length) {
      throw new TripError('invalid_trip', 'Some details need fixing.', {
        fields: { dates: 'Choose a valid date range.' },
      });
    }
    const id = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO trips (owner_id, owner_username, name, destination_name,
                            destination_lat, destination_lng, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          viewer.id,
          viewer.username,
          draft.name,
          draft.destination ? draft.destination.name : null,
          draft.destination ? draft.destination.lat : null,
          draft.destination ? draft.destination.lng : null,
          draft.startDate,
          draft.endDate,
        ],
      );
      const newId = String(rows[0].id);
      for (let i = 0; i < dates.length; i += 1) {
        await client.query(
          'INSERT INTO trip_days (trip_id, day_date, position) VALUES ($1,$2,$3)',
          [newId, dates[i], i],
        );
      }
      return newId;
    });
    return loadDetail(pool, viewer, id);
  }

  // Edit a trip's details. Shrinking the range is allowed only when no day
  // that would disappear still holds items; silently dropping a populated day
  // would lose the itinerary, so that edit is refused instead.
  async function update(viewer, rawId, body) {
    const id = model.parseTripId(rawId);
    const patch = body && typeof body === 'object' ? body : {};
    await tx(async (client) => {
      const row = await lockTrip(client, viewer, id);
      const merged = {
        name: 'name' in patch ? patch.name : row.name,
        destination: 'destination' in patch
          ? patch.destination
          : row.destination_name == null
            ? null
            : { name: row.destination_name, lat: row.destination_lat, lng: row.destination_lng },
        startDate: 'startDate' in patch ? patch.startDate : isoDay(row.start_date),
        endDate: 'endDate' in patch ? patch.endDate : isoDay(row.end_date),
      };
      const draft = model.validateTrip(merged);
      const dates = model.expandDays(draft.startDate, draft.endDate);
      if (!dates.length) {
        throw new TripError('invalid_trip', 'Some details need fixing.', {
          status: 409,
          fields: { dates: 'Choose a valid date range.' },
        });
      }
      const kept = new Set(dates);
      const { rows: existingDays } = await client.query(
        'SELECT * FROM trip_days WHERE trip_id = $1 ORDER BY position',
        [id],
      );
      const dropping = existingDays.filter((d) => !kept.has(isoDay(d.day_date)));
      if (dropping.length) {
        const { rows: counts } = await client.query(
          'SELECT trip_day_id, count(*)::int AS n FROM trip_items WHERE trip_day_id = ANY($1::bigint[]) GROUP BY trip_day_id',
          [dropping.map((d) => d.id)],
        );
        if (counts.some((c) => c.n > 0)) {
          throw new TripError(
            'day_not_empty',
            'This change would remove a day that still has stops in it.',
            { status: 409, fields: { dates: 'Remove the stops from the days that would disappear first.' } },
          );
        }
        await client.query('DELETE FROM trip_days WHERE id = ANY($1::bigint[])', [dropping.map((d) => d.id)]);
      }
      const existingDates = new Set(existingDays.map((d) => isoDay(d.day_date)));
      const keptDays = existingDays.filter((d) => kept.has(isoDay(d.day_date)));
      // Insert the days that are new, then renumber by date order so the
      // stored positions always follow the calendar.
      const dayIdByDate = new Map(keptDays.map((d) => [isoDay(d.day_date), d.id]));
      for (const date of dates) {
        if (existingDates.has(date)) continue;
        const { rows } = await client.query(
          `INSERT INTO trip_days (trip_id, day_date, position) VALUES ($1,$2,$3) RETURNING id`,
          [id, date, dates.indexOf(date)],
        );
        dayIdByDate.set(date, rows[0].id);
      }
      // Negative-shift to satisfy UNIQUE(trip_id, position) while renumbering.
      await client.query('UPDATE trip_days SET position = -1 - position WHERE trip_id = $1', [id]);
      for (let i = 0; i < dates.length; i += 1) {
        await client.query('UPDATE trip_days SET position = $2 WHERE id = $1', [dayIdByDate.get(dates[i]), i]);
      }
      await client.query(
        `UPDATE trips SET name=$2, destination_name=$3, destination_lat=$4, destination_lng=$5,
                start_date=$6, end_date=$7, updated_at=now() WHERE id=$1`,
        [
          id,
          draft.name,
          draft.destination ? draft.destination.name : null,
          draft.destination ? draft.destination.lat : null,
          draft.destination ? draft.destination.lng : null,
          draft.startDate,
          draft.endDate,
        ],
      );
    });
    return loadDetail(pool, viewer, id);
  }

  async function remove(viewer, rawId) {
    const id = model.parseTripId(rawId);
    await tx(async (client) => {
      await lockTrip(client, viewer, id);
      await client.query('DELETE FROM trips WHERE id = $1', [id]);
    });
    return { ok: true, id };
  }

  async function addItem(viewer, rawId, rawDayId, body) {
    const id = model.parseTripId(rawId);
    const dayId = model.parseDayId(rawDayId);
    const item = model.validateItem(body);
    await tx(async (client) => {
      await lockTrip(client, viewer, id);
      await readDay(client, id, dayId);
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM trip_items WHERE trip_day_id = $1',
        [dayId],
      );
      await client.query(
        `INSERT INTO trip_items (trip_day_id, place_id, place_snapshot, position, start_time, duration_minutes, notes)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
        [
          dayId,
          item.placeId,
          item.placeSnapshot ? JSON.stringify(item.placeSnapshot) : null,
          rows[0].n,
          item.startTime,
          item.durationMinutes,
          item.notes,
        ],
      );
    });
    return loadDetail(pool, viewer, id);
  }

  // Find an item through its day and trip, so an item id alone can never
  // reach another person's trip.
  async function findItem(client, tripId, itemId) {
    const { rows } = await client.query(
      `SELECT i.*, d.trip_id FROM trip_items i
         JOIN trip_days d ON d.id = i.trip_day_id
        WHERE i.id = $1 AND d.trip_id = $2`,
      [itemId, tripId],
    );
    if (!rows[0]) throw new TripError('not_found', 'That stop does not exist.', { status: 404 });
    return rows[0];
  }

  async function updateItem(viewer, rawId, rawItemId, body) {
    const id = model.parseTripId(rawId);
    const itemId = model.parseItemId(rawItemId);
    await tx(async (client) => {
      await lockTrip(client, viewer, id);
      const existing = await findItem(client, id, itemId);
      const patch = model.validateItem(body, { partial: true });
      const next = {
        place_id: 'placeId' in patch ? patch.placeId : existing.place_id,
        place_snapshot: 'placeSnapshot' in patch ? patch.placeSnapshot : existing.place_snapshot,
        start_time: 'startTime' in patch ? patch.startTime : existing.start_time,
        duration_minutes: 'durationMinutes' in patch ? patch.durationMinutes : existing.duration_minutes,
        notes: 'notes' in patch ? patch.notes : existing.notes,
      };
      await client.query(
        `UPDATE trip_items SET place_id=$2, place_snapshot=$3::jsonb, start_time=$4,
                duration_minutes=$5, notes=$6 WHERE id=$1`,
        [
          itemId,
          next.place_id,
          next.place_snapshot ? JSON.stringify(next.place_snapshot) : null,
          next.start_time,
          next.duration_minutes,
          next.notes,
        ],
      );
    });
    return loadDetail(pool, viewer, id);
  }

  async function removeItem(viewer, rawId, rawItemId) {
    const id = model.parseTripId(rawId);
    const itemId = model.parseItemId(rawItemId);
    await tx(async (client) => {
      await lockTrip(client, viewer, id);
      const existing = await findItem(client, id, itemId);
      const dayId = String(existing.trip_day_id);
      await client.query('DELETE FROM trip_items WHERE id = $1', [itemId]);
      const remaining = await orderedItems(client, dayId);
      await setOrder(client, dayId, remaining.map((r) => String(r.id)));
    });
    return loadDetail(pool, viewer, id);
  }

  // Move an item within its day or into another day of the SAME trip. An
  // out-of-range target index is clamped into the target day server-side, so
  // a stale client cannot produce an order the database refuses.
  async function moveItem(viewer, rawId, rawItemId, body) {
    const id = model.parseTripId(rawId);
    const itemId = model.parseItemId(rawItemId);
    const patch = body && typeof body === 'object' ? body : {};
    const targetDayId = patch.dayId == null ? null : model.parseDayId(String(patch.dayId));
    const index = patch.index;
    await tx(async (client) => {
      await lockTrip(client, viewer, id);
      const existing = await findItem(client, id, itemId);
      const sourceDayId = String(existing.trip_day_id);
      const destDayId = targetDayId || sourceDayId;
      await readDay(client, id, destDayId);

      const source = await orderedItems(client, sourceDayId);
      const fromIndex = source.findIndex((r) => String(r.id) === String(itemId));
      if (fromIndex < 0) throw new TripError('not_found', 'That stop does not exist.', { status: 404 });

      if (sourceDayId === destDayId) {
        const ordered = model.moveWithin(source.map((r) => String(r.id)), fromIndex, Number(index));
        await setOrder(client, sourceDayId, ordered);
        return;
      }
      const dest = await orderedItems(client, destDayId);
      const { fromList, toList } = model.moveBetween(
        source.map((r) => String(r.id)),
        dest.map((r) => String(r.id)),
        fromIndex,
        index == null ? dest.length : Number(index),
      );
      // Park the moved row on a far-negative position and switch its day
      // first, so the unique (trip_day_id, position) constraint is satisfied
      // while both days are renumbered below.
      await client.query('UPDATE trip_items SET position = -1000000000, trip_day_id = $2 WHERE id = $1', [
        itemId,
        destDayId,
      ]);
      await setOrder(client, sourceDayId, fromList);
      await setOrder(client, destDayId, toList);
    });
    return loadDetail(pool, viewer, id);
  }

  // Staging only (the caller gates it on IS_STAGING). One obviously fake trip
  // owned by a fake identity, never the visitor, with fixed ids so it is
  // idempotent. At least one consecutive pair carries coordinates (so the
  // per-leg route request is exercised) and at least one omits them (so the
  // unavailable-route path is exercised too).
  async function seedStaging() {
    await pool.query(
      `INSERT INTO trips (id, owner_id, owner_username, name, destination_name,
                          destination_lat, destination_lng, start_date, end_date)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        DEMO_TRIP_ID,
        DEMO_OWNER,
        'Staging demo: Jakarta Weekend',
        'Jakarta',
        -6.2088,
        106.8456,
        '2026-06-13',
        '2026-06-14',
      ],
    );
    const days = [
      [910001, DEMO_TRIP_ID, '2026-06-13', 0],
      [910002, DEMO_TRIP_ID, '2026-06-14', 1],
    ];
    for (const [id, tripId, date, position] of days) {
      await pool.query(
        `INSERT INTO trip_days (id, trip_id, day_date, position) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [id, tripId, date, position],
      );
    }
    const items = [
      [920001, 910001, 'staging-demo-place-museum', { name: 'Staging demo: National Museum', category: 'place', address: 'Jl. Medan Merdeka Barat, Jakarta', coordinates: { lat: -6.1760, lng: 106.8215 } }, 0, '09:30', 120, 'Staging demo stop.'],
      [920002, 910001, 'staging-demo-place-monas', { name: 'Staging demo: Monas', category: 'place', address: 'Gambir, Jakarta', coordinates: { lat: -6.1754, lng: 106.8272 } }, 1, '12:30', 90, null],
      [920003, 910002, 'staging-demo-place-kota-tua', { name: 'Staging demo: Kota Tua', category: 'place', address: 'Pinangsia, Jakarta', coordinates: { lat: -6.1352, lng: 106.8133 } }, 0, '10:00', null, null],
      [920004, 910002, 'staging-demo-place-ancol', { name: 'Staging demo: Ancol Beach', category: 'place', address: 'Ancol, North Jakarta', coordinates: null }, 1, null, null, 'Staging demo stop with no coordinates.'],
    ];
    for (const [id, dayId, placeId, snapshot, position, startTime, duration, notes] of items) {
      await pool.query(
        `INSERT INTO trip_items (id, trip_day_id, place_id, place_snapshot, position, start_time, duration_minutes, notes)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [id, dayId, placeId, JSON.stringify(snapshot), position, startTime, duration, notes],
      );
    }
  }

  return {
    migrate,
    seedStaging,
    list,
    get,
    getDemo,
    create,
    update,
    remove,
    addItem,
    updateItem,
    removeItem,
    moveItem,
  };
}

module.exports = { createStore, SCHEMA_SQL, DEMO_TRIP_ID, DEMO_OWNER };
