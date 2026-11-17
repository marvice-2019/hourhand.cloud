// Test helpers for the Clinic plan's Postgres tests: a fresh, migrated database per test file, and small row makers.
import pg from "pg";
import { migrate } from "../../../scripts/migrate";

export type Person = { id: string; email: string; slug: string };

/** Drops and recreates <TEST_DATABASE_URL's database>_<suffix>, migrates it and returns a pool on it. */
export async function freshDb(base: string, suffix: string): Promise<pg.Pool> {
  const u = new URL(base);
  const name = `${u.pathname.slice(1)}_${suffix}`;
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
  u.pathname = `/${name}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`drop database if exists ${name} with (force)`);
    await c.query(`create database ${name}`);
  } finally {
    await c.end();
  }
  await migrate(u.toString());
  return new pg.Pool({ connectionString: u.toString() });
}

export async function person(pool: pg.Pool, email: string, name: string, slug: string): Promise<Person> {
  return (await pool.query("insert into users (email, name, slug) values ($1, $2, $3) returning id, email, slug", [email, name, slug])).rows[0];
}

export async function plan(pool: pg.Pool, userId: string, p: string, status = "active", extraSeats = 0): Promise<void> {
  await pool.query(
    `insert into subscriptions (user_id, plan, status, extra_seats) values ($1, $2, $3, $4)
     on conflict (user_id) do update set plan = $2, status = $3, extra_seats = $4`, [userId, p, status, extraSeats]);
}

export async function eventType(pool: pg.Pool, userId: string, name: string, slug: string, extra: { price?: number } = {}): Promise<string> {
  return (await pool.query("insert into event_types (user_id, name, slug, duration_minutes, price_minor, currency) values ($1, $2, $3, 60, $4, $5) returning id",
    [userId, name, slug, extra.price ?? null, extra.price ? "INR" : null])).rows[0].id;
}

export async function booking(pool: pg.Pool, hostId: string, eventTypeId: string, start: Date, guest: { name: string; email: string; answers?: unknown[] }): Promise<string> {
  const end = new Date(start.getTime() + 3_600_000);
  const { rows: [b] } = await pool.query(
    `insert into bookings (event_type_id, host_id, start_at, end_at, buffered_start, buffered_end, idempotency_key)
     values ($1, $2, $3, $4, $3, $4, $5) returning id`, [eventTypeId, hostId, start, end, `k-${Math.random()}`]);
  await pool.query("insert into invitees (booking_id, host_id, name, email, timezone, answers) values ($1, $2, $3, $4, 'Asia/Kolkata', $5)",
    [b.id, hostId, guest.name, guest.email, JSON.stringify(guest.answers ?? [])]);
  return b.id;
}
