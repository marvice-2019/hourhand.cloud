import { LIMITS, type Plan } from "../billing/plans";
import type { BookingWithInvitee, User } from "../data/types";
import type { JitsiConfig } from "./config";
import { CLOSES_AFTER_MS, OPENS_BEFORE_MS, mintJoinToken } from "./jwt";
import { HOURHAND_VIDEO } from "./links";
import { roomKey, type RoomStore } from "./rooms";

// Who may join a booking's room, checked afresh on every visit to /v/<manage token>: the booking as it is now (a
// cancelled or moved booking's link stops working), the time, the host's plan and the server's setup.

export type JoinRole = "host" | "guest";

export type JoinRefusal =
  | "not_found" // no booking for this link
  | "not_video" // the booking isn't on Hourhand video
  | "not_set_up" // this server has no Jitsi settings
  | "plan" // the host's plan doesn't include Hourhand video
  | "cancelled" // cancelled, or moved to another time (the old booking is cancelled)
  | "not_confirmed" // still waiting for payment
  | "too_early"
  | "ended";

export type JoinCheck = { ok: true; opensAt: Date; closesAt: Date } | { ok: false; reason: JoinRefusal; opensAt?: Date; closesAt?: Date };

/** Whether a booking's room may be joined now. Pure: the caller supplies the plan and whether Jitsi is set up. */
export function checkJoin(booking: Pick<BookingWithInvitee, "status" | "locationKind" | "startAt" | "endAt">, ctx: { plan: Plan; configured: boolean; now: Date }): JoinCheck {
  if (booking.locationKind !== HOURHAND_VIDEO) return { ok: false, reason: "not_video" };
  if (!ctx.configured) return { ok: false, reason: "not_set_up" };
  if (!LIMITS[ctx.plan].hourhandVideo) return { ok: false, reason: "plan" };
  if (booking.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (booking.status !== "confirmed") return { ok: false, reason: "not_confirmed" };
  const opensAt = new Date(booking.startAt.getTime() - OPENS_BEFORE_MS);
  const closesAt = new Date(booking.endAt.getTime() + CLOSES_AFTER_MS);
  if (ctx.now < opensAt) return { ok: false, reason: "too_early", opensAt, closesAt };
  if (ctx.now >= closesAt) return { ok: false, reason: "ended", opensAt, closesAt };
  return { ok: true, opensAt, closesAt };
}

export interface JoinDeps {
  getBookingByManageToken(token: string): Promise<BookingWithInvitee | null>;
  /** One of the host's own bookings (scoped to that host). */
  getBooking(hostId: string, bookingId: string): Promise<BookingWithInvitee | null>;
  getUser(id: string): Promise<User | null>;
  /** The host's plan right now. */
  planFor(hostId: string): Promise<Plan>;
  /** The account the signed-in person works on (a Duo second person acting for the owner counts as that owner), or null. */
  signedInHostId(): Promise<string | null>;
  rooms: RoomStore;
  config: JitsiConfig | null;
  now: Date;
}

export type JoinResult =
  | { ok: true; role: JoinRole; url: string }
  | { ok: false; reason: "sign_in"; role: "host"; booking: null }
  | { ok: false; reason: JoinRefusal; role: JoinRole; booking: BookingWithInvitee | null; opensAt?: Date; closesAt?: Date };

/**
 * Resolves one visit to /v/<token>. The booking's host (signed in) joins as moderator; anyone else holding the guest's
 * link joins as that guest, a participant who waits in the lobby. Returns the Jitsi URL carrying a fresh token.
 */
export async function resolveJoin(deps: JoinDeps, token: string): Promise<JoinResult> {
  const booking = await deps.getBookingByManageToken(token);
  if (!booking) return { ok: false, reason: "not_found", role: "guest", booking: null };
  const role: JoinRole = (await deps.signedInHostId()) === booking.hostId ? "host" : "guest";
  return admit(deps, booking, role);
}

/**
 * Resolves one visit to /v/host/<booking id>, the host's own link (host emails, the host's calendar, the dashboard).
 * Only the signed-in host of that booking gets in; anyone else is asked to sign in, or finds nothing.
 */
export async function resolveHostJoin(deps: JoinDeps, bookingId: string): Promise<JoinResult> {
  const hostId = await deps.signedInHostId();
  if (!hostId) return { ok: false, reason: "sign_in", role: "host", booking: null };
  const booking = /^[0-9a-f-]{36}$/i.test(bookingId) ? await deps.getBooking(hostId, bookingId) : null;
  if (!booking || booking.hostId !== hostId) return { ok: false, reason: "not_found", role: "host", booking: null };
  return admit(deps, booking, "host");
}

async function admit(deps: JoinDeps, booking: BookingWithInvitee, role: JoinRole): Promise<JoinResult> {
  const check = checkJoin(booking, { plan: await deps.planFor(booking.hostId), configured: deps.config !== null, now: deps.now });
  if (!check.ok || !deps.config) {
    const reason = check.ok ? "not_set_up" : check.reason;
    return { ok: false, reason, role, booking, opensAt: check.opensAt, closesAt: check.closesAt };
  }
  let user: { id: string; name: string; email: string };
  if (role === "host") {
    const host = await deps.getUser(booking.hostId);
    if (!host) return { ok: false, reason: "not_found", role, booking };
    user = { id: `host:${host.id}`, name: host.name || host.email, email: host.email };
  } else {
    user = { id: `guest:${booking.invitee.id}`, name: booking.invitee.name, email: booking.invitee.email };
  }
  const room = await deps.rooms.roomFor(roomKey(booking), booking.hostId);
  const jwt = mintJoinToken(deps.config, { room, moderator: role === "host", user, startAt: booking.startAt, endAt: booking.endAt, now: deps.now });
  return { ok: true, role, url: jitsiRoomUrl(deps.config, room, jwt) };
}

/** https://<domain>/<room>?jwt=<token>. The token only ever travels in this redirect, never in an email or a page. */
export function jitsiRoomUrl(cfg: JitsiConfig, room: string, jwt: string): string {
  return `https://${cfg.domain}/${encodeURIComponent(room)}?jwt=${encodeURIComponent(jwt)}`;
}
