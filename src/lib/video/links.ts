import type { LocationKind } from "../data/types";

/** The location kind for a private room on the owner's Jitsi server. */
export const HOURHAND_VIDEO = "hourhand_video" as const satisfies LocationKind;

/**
 * Who a join link is for. The guest's link carries their manage token, so it never goes to the host or an extra guest
 * (the same rule as the manage link). The host's link names the booking and only works for the signed-in host.
 * An extra guest's link is made per email by the worker (see guest-links.ts), so it isn't built here.
 */
export type VideoAudience = "guest" | "host" | "extra_guest";

const trim = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

/**
 * The join link for a booking on Hourhand video: Hourhand's own /v/ page, which checks who is joining on every visit
 * and only then sends them on to the room with a fresh token. Null for any other location. Never contains a token.
 */
export function videoJoinUrl(baseUrl: string, locationKind: string | null | undefined, manageToken: string | null | undefined): string | null {
  if (locationKind !== HOURHAND_VIDEO || !manageToken) return null;
  return `${trim(baseUrl)}/v/${encodeURIComponent(manageToken)}`;
}

/** The host's join link: /v/host/<booking id>. */
export function hostVideoJoinUrl(baseUrl: string, locationKind: string | null | undefined, bookingId: string): string | null {
  if (locationKind !== HOURHAND_VIDEO) return null;
  return `${trim(baseUrl)}/v/host/${encodeURIComponent(bookingId)}`;
}

/** The right join link for whoever reads it. */
export function videoJoinUrlFor(audience: VideoAudience, baseUrl: string, locationKind: string | null | undefined, b: { bookingId: string; manageToken: string | null | undefined }): string | null {
  if (audience === "host") return hostVideoJoinUrl(baseUrl, locationKind, b.bookingId);
  if (audience === "extra_guest") return null;
  return videoJoinUrl(baseUrl, locationKind, b.manageToken);
}

/** An extra guest's own join link: /v/g/<token>. */
export function extraGuestVideoJoinUrl(baseUrl: string, token: string): string {
  return `${trim(baseUrl)}/v/g/${encodeURIComponent(token)}`;
}
