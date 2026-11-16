// Named availability schedules against real Postgres. Runs only with TEST_DATABASE_URL; uses its own database
// (<that name>_schedules) so it can build the schema without this feature's migration and check the upgrade.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { freeSlots } from "../booking";
import { LIMITS } from "../billing/plans";
import { createPgStore } from "./pg-store";
import { DefaultScheduleError, NotFoundError, ScheduleInUseError, ScheduleLimitError, SlotTakenError, type DataStore, type User } from "./types";

const BASE = process.env.TEST_DATABASE_URL;
const DIR = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
const NOW = new Date("2030-03-25T00:00:00Z"); // a Monday
const WEEK = { from: new Date("2030-03-25T00:00:00Z"), to: new Date("2030-04-08T00:00:00Z") }; // across the UK clock change
const guest = (n: string) => ({ name: `Guest ${n}`, email: `guest${n}@example.com`, timezone: "Asia/Kolkata", phone: null, answers: [] });

describe.skipIf(!BASE)("named schedules in Postgres (TEST_DATABASE_URL)", () => {
  let url: string;
  let pool: pg.Pool;
  let store: DataStore;
  let users: Record<"kept" | "fresh" | "twin", User>;
  let before: Record<string, string[]>;
  const ids: Record<string, string> = {};

  const q = (sql: string, values: unknown[] = []) => pool.query(sql, values);
  const slotsOf = async (user: User, eventTypeId: string) =>
    (await freeSlots(store, user, (await store.getEventType(user.id, eventTypeId))!, WEEK.from, WEEK.to, NOW)).map((d) => d.toISOString());

  beforeAll(async () => {
    const base = new URL(BASE!);
    const name = `${base.pathname.slice(1)}_schedules`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    const admin = new pg.Client({ connectionString: Object.assign(new URL(base), { pathname: "/postgres" }).toString() });
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.query(`create database ${name}`);
    } finally {
      await admin.end();
    }
    url = Object.assign(new URL(base), { pathname: `/${name}` }).toString();
    pool = new pg.Pool({ connectionString: url });
    store = createPgStore(pool);

    // Production as it stands before this feature: every other migration applied (later-numbered ones that merged
    // first included), recorded the way scripts/migrate does. migrate() below then applies named schedules last.
    const files = (await readdir(DIR)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const cut = files.findIndex((f) => f.endsWith("_named_schedules.sql"));
    expect(cut).toBeGreaterThan(0);
    await q("create table schema_migrations (version text primary key, applied_at timestamptz not null default now())");
    for (const f of files.filter((_, i) => i !== cut)) {
      await q(await readFile(DIR + f, "utf8"));
      await q("insert into schema_migrations (version) values ($1)", [f.slice(0, -4)]);
    }

    // kept: a host who already had a default schedule (lunch break, a day off) and two event types, one with
    // schedule_id null. fresh: signed up, never opened the dashboard, so no schedule yet. twin: same zone as fresh,
    // whose schedule the app made on first visit before the upgrade.
    const mk = async (slug: string, tz: string) =>
      (await q(`insert into users (email, name, slug, timezone) values ($1, $2, $3, $4) returning id, email, name, slug, timezone, time_format, locale`,
        [`${slug}@example.com`, slug, slug, tz])).rows[0];
    const row = { kept: await mk("kept", "Asia/Kolkata"), fresh: await mk("fresh", "Europe/London"), twin: await mk("twin", "Europe/London") };
    users = Object.fromEntries(Object.entries(row).map(([k, r]) => [k, { id: r.id, email: r.email, name: r.name, slug: r.slug, timezone: r.timezone, timeFormat: r.time_format, locale: r.locale }])) as typeof users;

    const sch = (await q("insert into availability_schedules (user_id, name, timezone, is_default) values ($1, 'Working hours', 'Asia/Kolkata', true) returning id", [users.kept.id])).rows[0].id;
    ids.kept = sch;
    for (const d of [1, 2, 3, 4, 5]) {
      await q("insert into availability_rules (schedule_id, kind, weekday, intervals) values ($1, 'weekly', $2, $3)", [sch, d, JSON.stringify([{ from: "09:00", to: "13:00" }, { from: "14:00", to: "18:00" }])]);
    }
    await q("insert into availability_rules (schedule_id, kind, on_date, intervals) values ($1, 'date', '2030-03-27', '[]')", [sch]);
    const et = async (user: User, slug: string, scheduleId: string | null) =>
      (await q("insert into event_types (user_id, schedule_id, name, slug, duration_minutes, min_notice_minutes, booking_window_days) values ($1, $2, $3, $4, 45, 0, 730) returning id",
        [user.id, scheduleId, slug, slug])).rows[0].id as string;
    ids.keptNull = await et(users.kept, "consult", null);
    ids.keptSet = await et(users.kept, "review", sch);
    ids.fresh = await et(users.fresh, "chat", null);
    ids.twin = await et(users.twin, "chat", null);
    await store.getDefaultSchedule(users.twin.id); // the twin's first visit, before the upgrade

    before = { keptNull: await slotsOf(users.kept, ids.keptNull), keptSet: await slotsOf(users.kept, ids.keptSet), twin: await slotsOf(users.twin, ids.twin) };
    const { rows: [{ n }] } = await q("select count(*)::int as n from availability_schedules where user_id = $1", [users.fresh.id]);
    expect(n).toBe(0);

    expect(await migrate(url)).toEqual([files[cut].slice(0, -4)]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("upgrade", () => {
    it("leaves an existing host's schedule, rules and slots exactly as they were", async () => {
      expect(before.keptNull.length).toBeGreaterThan(0);
      expect(await slotsOf(users.kept, ids.keptNull)).toEqual(before.keptNull);
      expect(await slotsOf(users.kept, ids.keptSet)).toEqual(before.keptSet);
      const all = await store.listSchedules(users.kept.id);
      expect(all.map((s) => ({ id: s.id, name: s.name, isDefault: s.isDefault, types: s.eventTypes.map((e) => e.id).sort() })))
        .toEqual([{ id: ids.kept, name: "Working hours", isDefault: true, types: [ids.keptNull, ids.keptSet].sort() }]);
      expect((await store.getSchedule(users.kept.id, null)).rules).toHaveLength(6);
    });

    it("gives a host with no schedule the same default the first visit would have made", async () => {
      const mine = await store.listSchedules(users.fresh.id);
      expect(mine).toMatchObject([{ name: "Working hours", timezone: "Europe/London", isDefault: true }]);
      expect(await slotsOf(users.fresh, ids.fresh)).toEqual((await slotsOf(users.twin, ids.twin)));
      expect(await slotsOf(users.twin, ids.twin)).toEqual(before.twin);
    });

    it("leaves every host with exactly one default", async () => {
      const { rows } = await q("select u.slug, count(s.id) filter (where s.is_default)::int as defaults from users u left join availability_schedules s on s.user_id = u.id group by u.slug order by u.slug");
      expect(rows).toEqual([{ slug: "fresh", defaults: 1 }, { slug: "kept", defaults: 1 }, { slug: "twin", defaults: 1 }]);
    });
  });

  describe("after the upgrade", () => {
    it("keeps the plan's limit, even with two creates at once", async () => {
      const results = await Promise.allSettled([
        store.createSchedule(users.twin.id, { name: "Evenings" }, LIMITS.free.schedules),
        store.createSchedule(users.twin.id, { name: "Weekends" }, 2),
        store.createSchedule(users.twin.id, { name: "Mornings" }, 2),
      ]);
      expect(results[0]).toMatchObject({ status: "rejected", reason: expect.any(ScheduleLimitError) });
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await store.listSchedules(users.twin.id)).toHaveLength(2);
    });

    it("books each event type against its own schedule and zone, and a booking on one blocks the others", async () => {
      const uk = await store.createSchedule(users.kept.id, { name: "UK clients", timezone: "Europe/London" }, Infinity);
      await store.saveWeeklyHours(users.kept.id, uk.id, { 1: [{ from: "08:00", to: "10:00" }], 5: [{ from: "08:00", to: "10:00" }] });
      await store.setEventTypeSchedule(users.kept.id, ids.keptSet, uk.id);
      const ukSlots = await slotsOf(users.kept, ids.keptSet);
      // Friday 29 March on GMT, Monday 1 April on BST: same wall clock, an hour apart in UTC.
      expect(ukSlots.filter((s) => s.startsWith("2030-03-29"))).toContain("2030-03-29T08:00:00.000Z");
      expect(ukSlots.filter((s) => s.startsWith("2030-04-01"))).toContain("2030-04-01T07:00:00.000Z");
      expect(ukSlots.filter((s) => s.startsWith("2030-04-01"))).not.toContain("2030-04-01T09:00:00.000Z");
      // Friday 08:30 GMT is 14:00 IST: a UK booking then takes the same time off the default (IST) schedule.
      expect(await slotsOf(users.kept, ids.keptNull)).toContain("2030-03-29T08:30:00.000Z");
      await store.createBooking({ eventTypeId: ids.keptSet, startAt: new Date("2030-03-29T08:30:00Z"), idempotencyKey: "uk-fri", invitee: guest("1") });
      expect(await slotsOf(users.kept, ids.keptNull)).not.toContain("2030-03-29T08:30:00.000Z");
      // The database refuses the same time twice whatever the schedule.
      await expect(store.createBooking({ eventTypeId: ids.keptNull, startAt: new Date("2030-03-29T08:30:00Z"), idempotencyKey: "ist-fri", invitee: guest("2") }))
        .rejects.toBeInstanceOf(SlotTakenError);
    });

    it("counts a daily limit by the event type's own schedule zone", async () => {
      // On the London schedule, 23:00 UTC Monday and 10:00 UTC Monday are the same day; in Kolkata they are not.
      await q("update event_types set daily_limit = 1 where id = $1", [ids.keptSet]);
      await store.createBooking({ eventTypeId: ids.keptSet, startAt: new Date("2030-04-08T22:00:00Z"), idempotencyKey: "late-mon", invitee: guest("3") });
      await expect(store.createBooking({ eventTypeId: ids.keptSet, startAt: new Date("2030-04-08T10:00:00Z"), idempotencyKey: "early-mon", invitee: guest("4") }))
        .rejects.toBeInstanceOf(SlotTakenError);
      await q("update event_types set daily_limit = null where id = $1", [ids.keptSet]);
    });

    it("won't delete a schedule in use or the default; moves its event types when asked", async () => {
      const uk = (await store.listSchedules(users.kept.id)).find((s) => s.name === "UK clients")!;
      const refused = await store.deleteSchedule(users.kept.id, uk.id).catch((e) => e);
      expect(refused).toBeInstanceOf(ScheduleInUseError);
      expect((refused as ScheduleInUseError).eventTypes).toEqual([{ id: ids.keptSet, name: "review" }]);
      await expect(store.deleteSchedule(users.kept.id, ids.kept)).rejects.toBeInstanceOf(DefaultScheduleError);
      await expect(store.deleteSchedule(users.twin.id, uk.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.deleteSchedule(users.kept.id, uk.id, { moveTo: (await store.getDefaultSchedule(users.twin.id)).schedule.id })).rejects.toBeInstanceOf(NotFoundError);

      await store.deleteSchedule(users.kept.id, uk.id, { moveTo: ids.kept });
      expect((await store.getEventType(users.kept.id, ids.keptSet))!.scheduleId).toBe(ids.kept);
      expect(await store.listSchedules(users.kept.id)).toHaveLength(1);
      const { rows } = await q("select count(*)::int as n from availability_rules where schedule_id = $1", [uk.id]);
      expect(rows[0].n).toBe(0);
    });

    it("refuses a second schedule with the same name in another case", async () => {
      await expect(store.createSchedule(users.kept.id, { name: "WORKING HOURS" }, Infinity)).rejects.toMatchObject({ name: "ScheduleNameTakenError" });
    });
  });
});
