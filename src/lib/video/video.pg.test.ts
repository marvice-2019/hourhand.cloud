// Hourhand video against real Postgres: the migration, the room table, and the emails the queue really sends.
// Runs only with TEST_DATABASE_URL; uses its own database (<name>_video) so it can run beside the other suites.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import type { Mail, Mailer } from "../mail/mailer";
import { processDueNotifications } from "../jobs/worker";
import { pgExtraGuestLinks } from "./guest-links";
import { resolveExtraGuestJoin, resolveHostJoin, resolveJoin, type JoinDeps } from "./join";
import { verifyJwt } from "./jwt";
import { pgRoomStore, roomKey } from "./rooms";

const BASE = process.env.TEST_DATABASE_URL;
const MIN = 60_000;
const baseUrl = "https://hourhand.test";
const SECRET = "v".repeat(48);
const guest = { name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", phone: null, answers: [], guests: ["friend@example.com"] };

describe.skipIf(!BASE)("Hourhand video (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let coaching: EventType;
  let slot = 0;
  const nextStart = () => new Date(Date.UTC(2031, 2, 3 + slot++, 4, 0));

  const deps = (now: Date, signedIn: string | null = null): JoinDeps => ({
    getBookingByManageToken: (t) => store.getBookingByManageToken(t),
    getBooking: (h, id) => store.getBooking(h, id),
    getUser: (id) => store.getUser(id),
    planFor: async () => "solo",
    signedInHostId: async () => signedIn,
    rooms: pgRoomStore(pool),
    extraGuests: pgExtraGuestLinks(pool),
    config: { domain: "meet.hourhand.test", appId: "hourhand", secret: SECRET },
    now,
  });

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_video`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(`drop database if exists ${name} with (force)`);
      await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    await migrate(u.toString());
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    await pool.query("delete from calendar_connections");
    await pool.query("update notifications set status = 'skipped' where status = 'queued'");
    await pool.query("update event_locations set kind = 'hourhand_video', value = null where event_type_id = $1", [coaching.id]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("allows the new location kind and still refuses unknown ones", async () => {
    const insert = (kind: string) => pool.query("insert into event_locations (event_type_id, kind, position) values ($1, $2, 99) returning id", [coaching.id, kind]);
    await expect(insert("carrier_pigeon")).rejects.toThrow(/event_locations_kind_check/);
    const added = [await insert("hourhand_video"), await insert("google_meet")].map((r) => r.rows[0].id);
    await pool.query("delete from event_locations where id = any($1::uuid[])", [added]);
  });

  it("keeps one random room per key, even when two joins race", async () => {
    const rooms = pgRoomStore(pool);
    const [a, b] = await Promise.all([rooms.roomFor("booking:race", priya.id), rooms.roomFor("booking:race", priya.id)]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z2-7]{26}$/);
    expect(await rooms.roomFor("booking:other", priya.id)).not.toBe(a);
  });

  it("sends the guest and host their own join links and never a token, then refuses the link once cancelled", async () => {
    const b = await store.createBooking({ eventTypeId: coaching.id, startAt: nextStart(), idempotencyKey: `video-${Math.random()}`, invitee: guest });
    expect(b.locationKind).toBe("hourhand_video");
    const sent: Mail[] = [];
    const mailer: Mailer = { async send(mail) { sent.push(mail); return { id: `fake-${sent.length}` }; } };
    await processDueNotifications(pool, mailer, { baseUrl });
    const to = (who: string) => sent.find((m) => m.to === who)!;
    expect(to(guest.email).text).toContain(`Hourhand video: ${baseUrl}/v/${b.invitee.manageToken}`);
    expect(to(priya.email).text).toContain(`${baseUrl}/v/host/${b.id}`);
    expect(to(priya.email).text + to(priya.email).html).not.toContain(b.invitee.manageToken);
    const extra = to("friend@example.com");
    const extraToken = (await pool.query("select token from video_guest_links where booking_id = $1 and email = 'friend@example.com'", [b.id])).rows[0].token;
    expect(extra.text).toContain(`Hourhand video: ${baseUrl}/v/g/${extraToken}`);
    expect(extra.text + extra.html).not.toContain(b.invitee.manageToken);
    expect(await pgExtraGuestLinks(pool).linkFor(b.id, b.hostId, "FRIEND@example.com")).toBe(extraToken);
    for (const m of sent) {
      const all = m.text + m.html + JSON.stringify(m.attachments ?? []);
      expect(all).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
      expect(all).not.toMatch(/jwt=/i);
    }

    const during = new Date(b.startAt.getTime() - 10 * MIN);
    const asGuest = await resolveJoin(deps(during), b.invitee.manageToken);
    const asHost = await resolveHostJoin(deps(during, priya.id), b.id);
    if (!asGuest.ok || !asHost.ok) throw new Error("expected both to join");
    const room = (await pool.query("select room from video_rooms where room_key = $1", [roomKey(b)])).rows[0].room;
    expect(new URL(asGuest.url).pathname).toBe(`/${room}`);
    expect(verifyJwt(new URL(asGuest.url).searchParams.get("jwt")!, SECRET)).toMatchObject({ room, context: { user: { moderator: false } } });
    expect(verifyJwt(new URL(asHost.url).searchParams.get("jwt")!, SECRET)).toMatchObject({ room, context: { user: { moderator: true } } });

    const asFriend = await resolveExtraGuestJoin(deps(during), extraToken);
    if (!asFriend.ok) throw new Error(`expected the extra guest to join, got ${asFriend.reason}`);
    expect(new URL(asFriend.url).pathname).toBe(`/${room}`);
    expect(verifyJwt(new URL(asFriend.url).searchParams.get("jwt")!, SECRET)).toMatchObject({ room, context: { user: { moderator: false, email: "friend@example.com" } } });

    await store.cancelBooking(priya.id, b.id, "guest");
    expect(await resolveExtraGuestJoin(deps(during), extraToken)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await resolveJoin(deps(during), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await resolveHostJoin(deps(during, priya.id), b.id)).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("works for a one-off meeting: its booking is on Hourhand video and the guest joins its own room", async () => {
    const startAt = nextStart();
    const { eventType, token } = await store.createOneOffMeeting(priya.id, {
      name: "Contract review", durationMinutes: 30, location: { kind: "hourhand_video", value: null }, times: [startAt],
    }, new Date());
    expect((await store.listEventLocations(priya.id, eventType.id)).map((l) => l.kind)).toEqual(["hourhand_video"]);
    const b = await store.createBooking({ eventTypeId: eventType.id, startAt, idempotencyKey: `oneoff-video-${Math.random()}`, bookingLinkToken: token, invitee: guest });
    expect(b.locationKind).toBe("hourhand_video");
    const joined = await resolveJoin(deps(new Date(startAt.getTime() - 5 * MIN)), b.invitee.manageToken);
    if (!joined.ok) throw new Error(`expected a join, got ${joined.reason}`);
    const room = (await pool.query("select room from video_rooms where room_key = $1", [roomKey(b)])).rows[0].room;
    expect(new URL(joined.url).pathname).toBe(`/${room}`);
  });

  it("drops a host's rooms with their account", async () => {
    const { rows: [u] } = await pool.query("insert into users (email, name, slug, timezone) values ('gone@example.com', 'Gone', 'gone-host', 'Asia/Kolkata') returning id");
    await pgRoomStore(pool).roomFor("booking:gone", u.id);
    await pool.query("delete from users where id = $1", [u.id]);
    expect((await pool.query("select 1 from video_rooms where room_key = 'booking:gone'")).rowCount).toBe(0);
  });
});
