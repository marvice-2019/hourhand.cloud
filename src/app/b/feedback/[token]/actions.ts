"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { submitFeedback } from "@/lib/follow-ups/follow-ups";
import { linkKey } from "@/lib/follow-ups/tokens";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

/** Per client address: plenty for a guest with a few sessions, too few to probe tokens. */
const FEEDBACK_LIMIT = { max: 20, windowMs: 10 * 60_000 };

/** The guest's answer from the feedback page. No login: the signed link is the permission, and it works once. */
export async function sendFeedback(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const page = `/b/feedback/${encodeURIComponent(token)}`;
  if (!authEnabled()) redirect(page);
  if (!rateLimiter.take(`feedback:${clientIp(await headers())}`, FEEDBACK_LIMIT)) redirect(`${page}?error=too_many`);
  let key: Buffer;
  try { key = linkKey(); } catch { redirect(page); }
  const result = await submitFeedback(getPool(process.env.DATABASE_URL as string), key, token,
    { rating: form.get("rating"), comment: form.get("comment"), showPublicly: form.get("showPublicly"), anonymous: form.get("anonymous") }, "", new Date());
  if (result.status === "bad_input") redirect(`${page}?error=${result.field}`);
  redirect(result.status === "saved" ? `${page}?sent=1` : page);
}
