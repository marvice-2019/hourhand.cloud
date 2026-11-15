import { describe, expect, it } from "vitest";
import { LIMITS, type Plan } from "../billing/plans";
import type { BookingWithInvitee, User } from "../data/types";
import { renderBookingMail, type BookingMailContext } from "../mail/templates";
import type { BookingEmailKind } from "../data/notifications";
import { jitsiConfig, jitsiSetupProblem, type JitsiConfig } from "./config";
import { VIDEO_NEEDS_PLAN, VIDEO_NOT_SET_UP, videoAvailability, videoGateError } from "./gate";
import { memoryExtraGuestLinks } from "./guest-links";
import { checkJoin, resolveExtraGuestJoin, resolveHostJoin, resolveJoin, type JoinDeps, type JoinResult } from "./join";
import { JITSI_AUDIENCE, joinClaims, mintJoinToken, verifyJwt } from "./jwt";
import { extraGuestVideoJoinUrl, hostVideoJoinUrl, videoJoinUrl, videoJoinUrlFor } from "./links";
import { memoryRoomStore, newRoomName, roomKey } from "./rooms";

const MIN = 60_000;
const SECRET = "s".repeat(40);
const cfg: JitsiConfig = { domain: "meet.hourhand.test", appId: "hourhand", secret: SECRET };
const env = { JITSI_DOMAIN: "meet.hourhand.test", JITSI_APP_ID: "hourhand", JITSI_APP_SECRET: SECRET };
const START = new Date("2026-12-01T10:00:00Z");
const END = new Date("2026-12-01T10:30:00Z");
const sec = (d: Date | number) => Math.floor(new Date(d).getTime() / 1000);

const host: User = { id: "11111111-1111-1111-1111-111111111111", email: "priya@example.com", name: "Priya Sharma", slug: "priya", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" };
const otherHost = "22222222-2222-2222-2222-222222222222";

function booking(over: Partial<BookingWithInvitee> = {}, invitee: Partial<BookingWithInvitee["invitee"]> = {}): BookingWithInvitee {
  const id = over.id ?? "33333333-3333-3333-3333-333333333333";
  return {
    id, eventTypeId: "et1", hostId: host.id, startAt: START, endAt: END, bufferedStart: START, bufferedEnd: END, status: "confirmed",
    holdExpiresAt: null, locationKind: "hourhand_video", joinUrl: null, idempotencyKey: `k-${id}`, cancelledAt: null, cancelledBy: null,
    cancelReason: null, rescheduledFromId: null, seriesId: null, seriesIndex: null, classKey: null, createdAt: new Date("2026-11-01T00:00:00Z"),
    ...over,
    invitee: {
      id: `inv-${id}`, bookingId: id, hostId: host.id, name: "Kiran Rao", email: "kiran@example.com", timezone: "Europe/London", phone: null, answers: [],
      manageToken: `tok-${id}`, noShowAt: null, runningLateMinutes: null, runningLateAt: null, guests: [], locale: "en", whatsappOptIn: false, ...invitee,
    },
  };
}

function deps(bookings: BookingWithInvitee[], opts: { signedIn?: string | null; plan?: Plan; config?: JitsiConfig | null; now?: Date; rooms?: ReturnType<typeof memoryRoomStore>; extraGuests?: ReturnType<typeof memoryExtraGuestLinks> } = {}): JoinDeps {
  return {
    getBookingByManageToken: async (t) => bookings.find((b) => b.invitee.manageToken === t) ?? null,
    getBooking: async (hostId, id) => bookings.find((b) => b.id === id && b.hostId === hostId) ?? null,
    getUser: async (id) => (id === host.id ? host : null),
    planFor: async () => opts.plan ?? "solo",
    signedInHostId: async () => opts.signedIn ?? null,
    rooms: opts.rooms ?? memoryRoomStore(),
    extraGuests: opts.extraGuests ?? memoryExtraGuestLinks(),
    config: opts.config === undefined ? cfg : opts.config,
    now: opts.now ?? new Date(START.getTime() - 5 * MIN),
  };
}

/** The verified token and room from a successful join. */
function tokenOf(result: JoinResult) {
  if (!result.ok) throw new Error(`expected a join, got ${result.reason}`);
  const url = new URL(result.url);
  const jwt = url.searchParams.get("jwt")!;
  const claims = verifyJwt(jwt, SECRET) as ReturnType<typeof joinClaims> | null;
  if (!claims) throw new Error("token signature did not verify");
  return { url, room: decodeURIComponent(url.pathname.slice(1)), claims };
}

describe("Jitsi settings", () => {
  it("needs all three Runtime variables, a long secret and a bare host name", () => {
    expect(jitsiConfig(env)).toEqual(cfg);
    expect(jitsiConfig({ ...env, JITSI_DOMAIN: "" })).toBeNull();
    expect(jitsiConfig({ ...env, JITSI_APP_ID: undefined })).toBeNull();
    expect(jitsiConfig({ ...env, JITSI_APP_SECRET: "short" })).toBeNull();
    expect(jitsiConfig({ ...env, JITSI_DOMAIN: "https://meet.hourhand.test" })).toBeNull();
    expect(jitsiConfig({ ...env, JITSI_DOMAIN: "meet.hourhand.test/room" })).toBeNull();
    expect(jitsiSetupProblem({})).toMatch(/not set up on this server \(missing JITSI_DOMAIN, JITSI_APP_ID, JITSI_APP_SECRET\)/);
    expect(jitsiSetupProblem(env)).toBeNull();
  });
});

describe("join token claims", () => {
  const input = { room: "abcdefghijklmnopqrstuvwxyz", moderator: true, user: { id: "host:1", name: "Priya", email: "priya@example.com" }, startAt: START, endAt: END, now: START };

  it("names the room, issuer, audience and server, and is valid 15 minutes before the start to 30 after the end", () => {
    const c = joinClaims(cfg, input);
    expect(c).toMatchObject({ iss: "hourhand", aud: JITSI_AUDIENCE, sub: "meet.hourhand.test", room: input.room });
    expect(c.nbf).toBe(sec(START.getTime() - 15 * MIN));
    expect(c.exp).toBe(sec(END.getTime() + 30 * MIN));
    expect(c.context.features).toMatchObject({ recording: false, livestreaming: false, transcription: false });
  });

  it("makes the host a moderator who skips the lobby, and a guest a participant who waits in it", () => {
    expect(joinClaims(cfg, input).context.user).toMatchObject({ moderator: true, affiliation: "owner", lobby_bypass: true });
    expect(joinClaims(cfg, { ...input, moderator: false }).context.user).toMatchObject({ moderator: false, affiliation: "member", lobby_bypass: false });
  });

  it("is HS256-signed with the app secret and fails with any other", () => {
    const token = mintJoinToken(cfg, input);
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(verifyJwt(token, SECRET)).toMatchObject({ room: input.room });
    expect(verifyJwt(token, "x".repeat(40))).toBeNull();
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...joinClaims(cfg, input), room: "*" })).toString("base64url");
    expect(verifyJwt(`${h}.${forged}.${s}`, SECRET)).toBeNull();
  });
});

describe("rooms", () => {
  it("are random, unguessable names, never the booking id", () => {
    const names = new Set(Array.from({ length: 200 }, newRoomName));
    expect(names.size).toBe(200);
    for (const n of names) expect(n).toMatch(/^[a-z2-7]{26}$/);
  });

  it("are one per booking and one per group class", async () => {
    const rooms = memoryRoomStore();
    const a = booking({ id: "a" }); const b = booking({ id: "b" });
    expect(roomKey(a)).toBe("booking:a");
    expect(await rooms.roomFor(roomKey(a), host.id)).toBe(await rooms.roomFor(roomKey(a), host.id));
    expect(await rooms.roomFor(roomKey(a), host.id)).not.toBe(await rooms.roomFor(roomKey(b), host.id));
    expect(roomKey(booking({ id: "c", classKey: "et1:2026-12-01T10:00:00.000Z" }))).toBe("class:et1:2026-12-01T10:00:00.000Z");
  });
});

describe("who may join", () => {
  const b = booking();

  it("lets the signed-in host in as moderator through the guest's link or their own", async () => {
    for (const result of [await resolveJoin(deps([b], { signedIn: host.id }), b.invitee.manageToken), await resolveHostJoin(deps([b], { signedIn: host.id }), b.id)]) {
      const { url, room, claims } = tokenOf(result);
      expect(result.ok && result.role).toBe("host");
      expect(url.origin).toBe("https://meet.hourhand.test");
      expect(claims.room).toBe(room);
      expect(room).not.toContain(b.id);
      expect(claims.context.user).toMatchObject({ moderator: true, name: "Priya Sharma", email: "priya@example.com" });
    }
  });

  it("lets the guest in with their manage link as a participant, never a moderator", async () => {
    const result = await resolveJoin(deps([b]), b.invitee.manageToken);
    const { claims } = tokenOf(result);
    expect(result.ok && result.role).toBe("guest");
    expect(claims.context.user).toMatchObject({ moderator: false, lobby_bypass: false, name: "Kiran Rao", email: "kiran@example.com" });
  });

  it("gives the host and guest of one booking the same room", async () => {
    const d = deps([b]);
    const asHost = tokenOf(await resolveHostJoin({ ...d, signedInHostId: async () => host.id }, b.id));
    const asGuest = tokenOf(await resolveJoin(d, b.invitee.manageToken));
    expect(asHost.room).toBe(asGuest.room);
  });

  it("refuses an unknown link, and another host's own link to someone else's booking", async () => {
    expect(await resolveJoin(deps([b]), "nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect(await resolveHostJoin(deps([b], { signedIn: otherHost }), b.id)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await resolveHostJoin(deps([b], { signedIn: null }), b.id)).toMatchObject({ ok: false, reason: "sign_in" });
  });

  it("treats a different signed-in host holding the guest's link as that guest, not a moderator", async () => {
    const result = await resolveJoin(deps([b], { signedIn: otherHost }), b.invitee.manageToken);
    expect(result.ok && result.role).toBe("guest");
    expect(tokenOf(result).claims.context.user.moderator).toBe(false);
  });

  it("refuses a cancelled booking, and a booking still awaiting payment", async () => {
    expect(await resolveJoin(deps([booking({ status: "cancelled" })]), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await resolveHostJoin(deps([booking({ status: "cancelled" })], { signedIn: host.id }), b.id)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await resolveJoin(deps([booking({ status: "pending_payment" })]), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "not_confirmed" });
  });

  it("stops the old link of a rescheduled booking; the new booking has its own room", async () => {
    const old = booking({ id: "old", status: "cancelled", cancelledBy: "guest" });
    const moved = booking({ id: "new", rescheduledFromId: "old", startAt: new Date(START.getTime() + 60 * MIN), endAt: new Date(END.getTime() + 60 * MIN) });
    const rooms = memoryRoomStore();
    const beforeMove = tokenOf(await resolveJoin(deps([booking({ id: "old" })], { rooms }), "tok-old"));
    expect(await resolveJoin(deps([old, moved], { rooms }), "tok-old")).toMatchObject({ ok: false, reason: "cancelled" });
    const after = tokenOf(await resolveJoin(deps([old, moved], { rooms, now: new Date(moved.startAt.getTime() - 5 * MIN) }), "tok-new"));
    expect(after.room).not.toBe(beforeMove.room);
    // The token minted before the move expired with the old time; the new one follows the new time.
    expect(beforeMove.claims.exp).toBe(sec(END.getTime() + 30 * MIN));
    expect(after.claims.nbf).toBe(sec(moved.startAt.getTime() - 15 * MIN));
  });

  it("opens 15 minutes before the start and closes 30 minutes after the end", () => {
    const at = (ms: number) => checkJoin(b, { plan: "solo", configured: true, now: new Date(ms) });
    expect(at(START.getTime() - 15 * MIN - 1)).toMatchObject({ ok: false, reason: "too_early" });
    expect(at(START.getTime() - 15 * MIN).ok).toBe(true);
    expect(at(END.getTime() + 30 * MIN - 1).ok).toBe(true);
    expect(at(END.getTime() + 30 * MIN)).toMatchObject({ ok: false, reason: "ended" });
  });

  it("refuses too early and too late through the link too", async () => {
    expect(await resolveJoin(deps([b], { now: new Date(START.getTime() - 60 * MIN) }), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "too_early", opensAt: new Date(START.getTime() - 15 * MIN) });
    expect(await resolveJoin(deps([b], { signedIn: host.id, now: new Date(END.getTime() + 31 * MIN) }), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "ended", role: "host" });
  });

  it("refuses a booking that isn't on Hourhand video, and a server without the Jitsi settings", async () => {
    expect(await resolveJoin(deps([booking({ locationKind: "google_meet" })]), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "not_video" });
    expect(await resolveJoin(deps([b], { config: null }), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "not_set_up" });
  });

  it("puts every seat of a group class in one room, each as a participant", async () => {
    const classKey = "et1:2026-12-01T10:00:00.000Z";
    const seatId = (n: number) => `aaaaaaaa-aaaa-aaaa-aaaa-00000000000${n}`;
    const seats = [seatId(1), seatId(2), seatId(3)].map((id, i) => booking({ id, classKey }, { name: `Student ${i + 1}`, email: `s${i + 1}@example.com` }));
    const other = booking({ id: "s4", classKey: "et1:2026-12-02T10:00:00.000Z" });
    const d = deps([...seats, other]);
    const joined = await Promise.all(seats.map((s) => resolveJoin(d, s.invitee.manageToken).then(tokenOf)));
    expect(new Set(joined.map((j) => j.room)).size).toBe(1);
    expect(joined.map((j) => j.claims.context.user.moderator)).toEqual([false, false, false]);
    expect(joined.map((j) => j.claims.context.user.email)).toEqual(["s1@example.com", "s2@example.com", "s3@example.com"]);
    const host_ = tokenOf(await resolveHostJoin({ ...d, signedInHostId: async () => host.id }, seatId(2)));
    expect(host_.room).toBe(joined[0].room);
    expect(tokenOf(await resolveJoin(d, other.invitee.manageToken)).room).not.toBe(joined[0].room);
    // A cancelled seat's link stops working; the others carry on.
    const d2 = deps([booking({ id: seatId(1), classKey, status: "cancelled" }), ...seats.slice(1)], { rooms: d.rooms });
    expect(await resolveJoin(d2, `tok-${seatId(1)}`)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(tokenOf(await resolveJoin(d2, `tok-${seatId(2)}`)).room).toBe(joined[0].room);
  });
});

describe("extra guests' own links", () => {
  const withGuests = (over: Partial<BookingWithInvitee> = {}) => booking(over, { guests: ["asha@example.com", "dev@example.com"] });

  it("let each extra guest in as a participant under their own email, in the booking's room", async () => {
    const b = withGuests();
    const d = deps([b]);
    const asha = await d.extraGuests.linkFor(b.id, b.hostId, "asha@example.com");
    const dev = await d.extraGuests.linkFor(b.id, b.hostId, "dev@example.com");
    expect(asha).not.toBe(dev);
    expect(await d.extraGuests.linkFor(b.id, b.hostId, "asha@example.com")).toBe(asha);
    const joined = tokenOf(await resolveExtraGuestJoin(d, asha));
    expect(joined.claims.context.user).toMatchObject({ moderator: false, lobby_bypass: false, email: "asha@example.com", name: "asha@example.com" });
    expect(joined.room).toBe(tokenOf(await resolveJoin(d, b.invitee.manageToken)).room);
    expect(asha).not.toContain(b.invitee.manageToken);
  });

  it("stop working when the email is taken off the booking, the booking is cancelled, or the link is unknown", async () => {
    const b = withGuests();
    const links = memoryExtraGuestLinks();
    const asha = await links.linkFor(b.id, b.hostId, "asha@example.com");
    expect(await resolveExtraGuestJoin(deps([booking({}, { guests: ["dev@example.com"] })], { extraGuests: links }), asha)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await resolveExtraGuestJoin(deps([withGuests({ status: "cancelled" })], { extraGuests: links }), asha)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await resolveExtraGuestJoin(deps([b], { extraGuests: links }), "x".repeat(32))).toMatchObject({ ok: false, reason: "not_found" });
    expect(await resolveExtraGuestJoin(deps([b], { extraGuests: links, now: new Date(START.getTime() - 60 * MIN) }), asha)).toMatchObject({ ok: false, reason: "too_early" });
  });

  it("are tied to one booking: the same email on a moved booking gets a new link, and the old one is refused", async () => {
    const links = memoryExtraGuestLinks();
    const old = withGuests({ id: "old" });
    const oldLink = await links.linkFor("old", host.id, "asha@example.com");
    const newLink = await links.linkFor("new", host.id, "asha@example.com");
    expect(newLink).not.toBe(oldLink);
    expect(await resolveExtraGuestJoin(deps([withGuests({ id: "old", status: "cancelled" }), withGuests({ id: "new" })], { extraGuests: links }), oldLink)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(old.status).toBe("confirmed");
  });
});

describe("plans", () => {
  it("includes Hourhand video on Solo and Duo only", () => {
    expect(LIMITS.free.hourhandVideo).toBe(false);
    expect(LIMITS.solo.hourhandVideo).toBe(true);
    expect(LIMITS.duo.hourhandVideo).toBe(true);
  });

  it("refuses joining when the host's plan doesn't include it", async () => {
    const b = booking();
    expect(await resolveJoin(deps([b], { plan: "free" }), b.invitee.manageToken)).toMatchObject({ ok: false, reason: "plan" });
    expect(await resolveHostJoin(deps([b], { plan: "free", signedIn: host.id }), b.id)).toMatchObject({ ok: false, reason: "plan" });
    expect((await resolveJoin(deps([b], { plan: "duo" }), b.invitee.manageToken)).ok).toBe(true);
  });

  it("gates picking it in the editor: needs the server set up and a paid plan, but keeping it is allowed", () => {
    expect(videoAvailability("free", true)).toBe("plan");
    expect(videoAvailability("solo", false)).toBe("not_set_up");
    expect(videoAvailability("duo", true)).toBe("ready");
    expect(videoGateError({ chosen: true, alreadyChosen: false, availability: "plan" })).toBe(VIDEO_NEEDS_PLAN);
    expect(videoGateError({ chosen: true, alreadyChosen: false, availability: "not_set_up" })).toBe(VIDEO_NOT_SET_UP);
    expect(videoGateError({ chosen: true, alreadyChosen: false, availability: "ready" })).toBeNull();
    expect(videoGateError({ chosen: true, alreadyChosen: true, availability: "plan" })).toBeNull();
    expect(videoGateError({ chosen: false, alreadyChosen: false, availability: "plan" })).toBeNull();
  });
});

describe("join links in emails", () => {
  const base = "https://hourhand.test";
  const guestToken = "guest-only-manage-token";
  const ctxFor = (audience: "guest" | "host" | "extra_guest"): BookingMailContext => ({
    bookingId: "b1", eventName: "Coaching", hostName: "Priya Sharma", hostEmail: "priya@example.com", hostTimezone: "Asia/Kolkata", hostTimeFormat: "24h",
    guestName: "Kiran", guestEmail: "kiran@example.com", guestTimezone: "Europe/London", startAt: START, endAt: END,
    location: { kind: "hourhand_video", value: null }, joinUrl: videoJoinUrlFor(audience, base, "hourhand_video", { bookingId: "b1", manageToken: guestToken }),
    answers: [], cancelledBy: null, cancelReason: null, previousStartAt: null, issuedAt: new Date("2026-11-15T00:00:00Z"),
    manageUrl: `${base}/b/${guestToken}`, dashboardUrl: `${base}/dashboard/bookings/b1`, extraGuest: audience === "extra_guest",
  });
  const kinds: BookingEmailKind[] = ["booked_guest", "booked_host", "reminder_guest", "rescheduled_guest", "rescheduled_host", "cancelled_guest", "cancelled_host"];

  it.each(kinds)("%s never carries a token or the Jitsi room", (kind) => {
    const audience = kind.endsWith("_host") ? "host" : "guest";
    const m = renderBookingMail(kind, ctxFor(audience));
    const all = m.text + m.html + JSON.stringify(m.attachments ?? []);
    expect(all).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
    expect(all).not.toMatch(/jwt=/i);
    expect(all).not.toContain("meet.hourhand.test");
  });

  it("gives the guest their own join link, the host theirs, and an extra guest their own", () => {
    expect(renderBookingMail("booked_guest", ctxFor("guest")).text).toContain(`Hourhand video: ${base}/b/${guestToken}/video`);
    const hostMail = renderBookingMail("booked_host", ctxFor("host"));
    expect(hostMail.text).toContain(`${base}/dashboard/bookings/b1/video`);
    expect(hostMail.text + hostMail.html).not.toContain(guestToken);
    const extra = renderBookingMail("booked_guest", { ...ctxFor("extra_guest"), joinUrl: extraGuestVideoJoinUrl(base, "A".repeat(32)) });
    expect(extra.text).toContain(`Hourhand video: ${base}/b/g/${"A".repeat(32)}`);
    expect(extra.text + extra.html).not.toContain(guestToken);
  });

  it("builds links only for Hourhand video bookings", () => {
    expect(videoJoinUrl(`${base}/`, "hourhand_video", "t")).toBe(`${base}/b/t/video`);
    expect(videoJoinUrl(base, "google_meet", "t")).toBeNull();
    expect(hostVideoJoinUrl(base, "zoom", "b1")).toBeNull();
  });
});
