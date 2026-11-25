"use server";

import { requireOwnAccount } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { checkSubscription, countSubscriptions, pushDeps, removeSubscription, saveSubscription, sendToHost, testPushMessage } from "@/lib/push/push";

// Phone alerts on one device (src/lib/push). Called from the Settings card with the browser's PushSubscription.

export type PushActionResult = { ok: true; devices: number } | { ok: false; error: "not_set_up" | "bad_subscription" | "failed" }; // i18n-ignore: not copy

/** Turns alerts on for the device that sent `subscription`. */
export async function turnOnPushAlerts(subscription: unknown, device: string): Promise<PushActionResult> {
  const user = await requireOwnAccount();
  if (!authEnabled() || !pushDeps()) return { ok: false, error: "not_set_up" }; // i18n-ignore: not copy
  const sub = checkSubscription(subscription);
  if (!sub) return { ok: false, error: "bad_subscription" }; // i18n-ignore: not copy
  const pool = getPool(process.env.DATABASE_URL as string);
  await saveSubscription(pool, user.id, sub, typeof device === "string" ? device : null, new Date());
  return { ok: true, devices: await countSubscriptions(pool, user.id) };
}

/** Turns alerts off for one device, by its push address. */
export async function turnOffPushAlerts(endpoint: unknown): Promise<PushActionResult> {
  const user = await requireOwnAccount();
  if (!authEnabled()) return { ok: false, error: "not_set_up" }; // i18n-ignore: not copy
  const pool = getPool(process.env.DATABASE_URL as string);
  if (typeof endpoint === "string") await removeSubscription(pool, user.id, endpoint);
  return { ok: true, devices: await countSubscriptions(pool, user.id) };
}

// One test every 10 seconds per host, per server process: it posts to push services in our name.
const lastTest = new Map<string, number>();

/** Sends a test alert to every device the host turned alerts on for. */
export async function sendTestPushAlert(): Promise<PushActionResult> {
  const user = await requireOwnAccount();
  const deps = pushDeps();
  if (!authEnabled() || !deps) return { ok: false, error: "not_set_up" }; // i18n-ignore: not copy
  const now = Date.now();
  if (now - (lastTest.get(user.id) ?? 0) < 10_000) return { ok: false, error: "failed" }; // i18n-ignore: not copy
  lastTest.set(user.id, now);
  const pool = getPool(process.env.DATABASE_URL as string);
  try {
    const out = await sendToHost(pool, deps, user.id, testPushMessage(user.hostLocale ?? null), new Date());
    if (out.sent === 0) return { ok: false, error: "failed" }; // i18n-ignore: not copy
    return { ok: true, devices: await countSubscriptions(pool, user.id) };
  } catch {
    return { ok: false, error: "failed" }; // i18n-ignore: not copy
  }
}
