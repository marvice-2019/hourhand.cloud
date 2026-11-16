import { authEnabled } from "../auth/auth";
import { getHostContext } from "../auth/session";
import { hostPlan } from "../billing/account";
import type { Plan } from "../billing/plans";
import { store } from "../data";
import { getPool } from "../data/pg-store";
import { jitsiConfig } from "./config";
import { videoAvailability, type VideoAvailability } from "./gate";
import type { JoinDeps } from "./join";
import { memoryExtraGuestLinks, pgExtraGuestLinks, type ExtraGuestLinks } from "./guest-links";
import { memoryRoomStore, pgRoomStore, type RoomStore } from "./rooms";

// Wiring for the app: the real store, plan, session and room table. The rules themselves live in join.ts and gate.ts.

const pool = () => (process.env.HOURHAND_DATA === "postgres" ? getPool(process.env.DATABASE_URL as string) : null);

/** The host's plan; demo (memory) data has no billing and counts as Free, like the booking-page footer. */
export async function planOf(hostId: string): Promise<Plan> {
  const p = pool();
  return p && authEnabled() ? hostPlan(p, hostId) : "free";
}

export async function videoAvailabilityFor(hostId: string): Promise<VideoAvailability> {
  return videoAvailability(await planOf(hostId), jitsiConfig() !== null);
}

const shared = globalThis as typeof globalThis & { __hourhandVideoRooms?: RoomStore; __hourhandVideoGuests?: ExtraGuestLinks };

export function joinDeps(now: Date): JoinDeps {
  const p = pool();
  return {
    getBookingByManageToken: (token) => store.getBookingByManageToken(token),
    getUser: (id) => store.getUser(id),
    getBooking: (hostId, id) => store.getBooking(hostId, id),
    planFor: planOf,
    signedInHostId: async () => (await getHostContext())?.host.id ?? null,
    rooms: p ? pgRoomStore(p) : (shared.__hourhandVideoRooms ??= memoryRoomStore()),
    extraGuests: p ? pgExtraGuestLinks(p) : (shared.__hourhandVideoGuests ??= memoryExtraGuestLinks()),
    config: jitsiConfig(),
    now,
  };
}
