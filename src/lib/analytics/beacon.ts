import { createHash } from "node:crypto";
import type pg from "pg";
import type { DataStore } from "../data/types";
import type { createRateLimiter, Limit } from "../rate-limit";
import { sourceFromBody } from "./source";
import { countable, track } from "./store";

/** Per visitor address (hashed): far above what one guest picking times sends, low enough to stop a flood. */
export const BEACON_LIMIT: Limit = { max: 60, windowMs: 10 * 60_000 };
/** A beacon is a few hundred bytes; anything much bigger isn't ours. */
const MAX_BODY = 2_048;

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;

export interface BeaconDeps {
  store: Pick<DataStore, "getPublicEventType">;
  limiter: Limiter;
  headers: Pick<Headers, "get">;
  clientKey: string;
  body: string;
  db: Pick<pg.Pool, "query">;
  now?: Date;
}

/** The limiter key for an address: a hash, so even the in-memory counters hold no address. */
export const beaconKey = (clientKey: string) => `analytics:${createHash("sha256").update(clientKey).digest("hex").slice(0, 32)}`;

/** A beacon must come from a page on this same site (no Origin, as some browsers send for same-origin, is allowed). */
function sameSite(headers: Pick<Headers, "get">): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === headers.get("host");
  } catch {
    return false;
  }
}

/**
 * POST /api/events from a booking page: `{ kind: "slot_click", slug, event, src }`. Returns the work that records it
 * (to run after the response), or null when it is ignored: opted out, a bot, another site, over the limit, malformed,
 * or for a host or event type that doesn't exist publicly.
 */
export async function handleBeacon(d: BeaconDeps): Promise<(() => Promise<void>) | null> {
  if (!countable(d.headers) || !sameSite(d.headers) || d.body.length > MAX_BODY) return null;
  if (!d.limiter.take(beaconKey(d.clientKey), BEACON_LIMIT)) return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(d.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { kind, slug, event } = body;
  if (kind !== "slot_click" || typeof slug !== "string" || typeof event !== "string" || !slug || !event || slug.length > 100 || event.length > 100) return null;
  const found = await d.store.getPublicEventType(slug, event).catch((error) => { console.error("[analytics] beacon lookup failed", error); return null; });
  if (!found) return null;
  const source = sourceFromBody(body.src);
  return () => track(d.db, { headers: d.headers, clientKey: d.clientKey }, { hostId: found.host.id, eventTypeId: found.eventType.id, kind: "slot_click", source }, d.now);
}
