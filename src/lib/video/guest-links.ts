import { randomBytes } from "node:crypto";
import type pg from "pg";

// Extra guests (people the guest added to the booking) get a join link of their own, one per booking and email. It
// carries none of the guest's manage token, so it can join the call and do nothing else. A moved booking is a new
// booking, so its extra guests get new links and the old ones stop at the "cancelled or moved" page.

export interface ExtraGuestLink { token: string; bookingId: string; hostId: string; email: string }

export interface ExtraGuestLinks {
  /** The link for this extra guest on this booking, made on first call. Two calls at once get the same link. */
  linkFor(bookingId: string, hostId: string, email: string): Promise<string>;
  /** The booking and email a link belongs to, or null. */
  find(token: string): Promise<ExtraGuestLink | null>;
}

/** 32 characters of base64url (192 bits). */
export const newGuestToken = () => randomBytes(24).toString("base64url");

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function pgExtraGuestLinks(pool: pg.Pool): ExtraGuestLinks {
  return {
    async linkFor(bookingId, hostId, email) {
      await pool.query(
        `insert into video_guest_links (token, booking_id, host_id, email) values ($1, $2, $3, $4)
         on conflict (booking_id, email) do nothing`, [newGuestToken(), bookingId, hostId, email]);
      const { rows: [r] } = await pool.query("select token from video_guest_links where booking_id = $1 and email = $2", [bookingId, email]);
      return r.token as string;
    },
    async find(token) {
      if (!TOKEN.test(token)) return null;
      const { rows: [r] } = await pool.query("select token, booking_id, host_id, email::text as email from video_guest_links where token = $1", [token]);
      return r ? { token: r.token, bookingId: r.booking_id, hostId: r.host_id, email: r.email } : null;
    },
  };
}

/** For the demo (memory) data and tests. */
export function memoryExtraGuestLinks(): ExtraGuestLinks {
  const byKey = new Map<string, ExtraGuestLink>();
  const byToken = new Map<string, ExtraGuestLink>();
  return {
    async linkFor(bookingId, hostId, email) {
      const key = `${bookingId}:${email.toLowerCase()}`;
      let link = byKey.get(key);
      if (!link) {
        link = { token: newGuestToken(), bookingId, hostId, email };
        byKey.set(key, link);
        byToken.set(link.token, link);
      }
      return link.token;
    },
    async find(token) {
      return byToken.get(token) ?? null;
    },
  };
}
