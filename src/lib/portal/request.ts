import { createHash } from "node:crypto";
import type pg from "pg";
import type { Locale } from "../i18n/guest";
import type { createRateLimiter, Limit } from "../rate-limit";
import { isClient, isEmail, issueLink, normalEmail } from "./store";
import { portalPath } from "./tokens";

type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;

/** Portal links: a few per email (stops one inbox being flooded) and more per address (stops sweeping many emails). */
export const PORTAL_LINK_LIMITS = {
  perEmail: { max: 3, windowMs: 10 * 60_000 },
  perIp: { max: 10, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;

export type RequestLinkResult = { status: "sent"; email: string } | { status: "invalid_email" } | { status: "too_many" };

export interface RequestLinkDeps {
  db: Pick<pg.Pool, "query">;
  key: Buffer;
  limiter: Limiter;
  now: Date;
  /** Emails the link. */
  send: (to: string, url: string) => Promise<void>;
  /** Runs the lookup and the send after the response has gone (next/server `after`), so timing reveals nothing either. */
  defer: (work: () => Promise<void>) => void;
}

/**
 * A client asks for a link to their portal with this host. The answer is the same whether or not the email has ever
 * booked here: the link is only made and sent, after the response, when it has. Limits count every request.
 */
export async function requestPortalLink(
  deps: RequestLinkDeps,
  input: { host: { id: string; slug: string }; email: unknown; ip: string; baseUrl: string; locale: Locale },
): Promise<RequestLinkResult> {
  const email = typeof input.email === "string" ? normalEmail(input.email) : "";
  if (!isEmail(email)) return { status: "invalid_email" };
  const ipKey = createHash("sha256").update(input.ip).digest("hex").slice(0, 32);
  if (!deps.limiter.take(`portal-ip:${ipKey}`, PORTAL_LINK_LIMITS.perIp)) return { status: "too_many" };
  if (!deps.limiter.take(`portal-email:${email}`, PORTAL_LINK_LIMITS.perEmail)) return { status: "too_many" };
  const { host } = input;
  deps.defer(async () => {
    try {
      if (!(await isClient(deps.db, host.id, email))) return;
      const token = await issueLink(deps.db, deps.key, host.id, email, deps.now);
      const url = `${input.baseUrl.replace(/\/+$/, "")}${portalPath(host.slug)}/open?lang=${input.locale}#${encodeURIComponent(token)}`;
      await deps.send(email, url);
    } catch (error) {
      console.error("portal link failed", error instanceof Error ? error.message : error);
    }
  });
  return { status: "sent", email };
}
