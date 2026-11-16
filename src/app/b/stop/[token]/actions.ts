"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { applyOptOut } from "@/lib/follow-ups/follow-ups";
import { linkKey } from "@/lib/follow-ups/tokens";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

/** The guest's "stop follow-ups from this host". The signed link names the host and the guest's email. */
export async function stopFollowUps(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "");
  const page = `/b/stop/${encodeURIComponent(token)}`;
  if (!authEnabled()) redirect(page);
  if (!rateLimiter.take(`opt-out:${clientIp(await headers())}`, { max: 20, windowMs: 10 * 60_000 })) redirect(page);
  let key: Buffer;
  try { key = linkKey(); } catch { redirect(page); }
  await applyOptOut(getPool(process.env.DATABASE_URL as string), key, token, new Date());
  redirect(`${page}?done=1${/^[a-z]{2}$/.test(lang) ? `&lang=${lang}` : ""}`);
}
