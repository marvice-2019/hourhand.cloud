import { headers } from "next/headers";
import { after } from "next/server";
import { authEnabled } from "../auth/auth";
import { getPool } from "../data/pg-store";
import { clientIp } from "../rate-limit";
import { sourceFromRequest, type SourceInput } from "./source";
import { countable, track } from "./store";

/**
 * Counts a booking page (or, with eventTypeId null, a profile page) as viewed, after the page is sent, and returns the
 * visit's source so the page can carry it on (links, the slot beacon and the booking request). Never throws.
 */
export async function countPageView(hostId: string, eventTypeId: string | null, params: Record<string, string | string[] | undefined>): Promise<SourceInput> {
  const h = await headers();
  const source = sourceFromRequest(params, h);
  // A router prefetch isn't a visit; neither is a bot, or a guest who asked not to be tracked.
  if (!authEnabled() || h.get("next-router-prefetch") || h.get("sec-purpose")?.includes("prefetch") || h.get("purpose") === "prefetch" || !countable(h)) return source;
  const copy = new Headers(h);
  const ctx = { headers: copy, clientKey: clientIp(copy) };
  const now = new Date();
  after(() => track(getPool(process.env.DATABASE_URL as string), ctx, { hostId, eventTypeId, kind: "view", source }, now));
  return source;
}
