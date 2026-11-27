"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { store } from "@/lib/data";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

/** B9: the guest withdraws a booking request the host hasn't answered yet. The manage link is the guest's proof. */
export async function withdrawRequest(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "");
  const page = `/b/${encodeURIComponent(token)}${/^[a-z]{2}$/.test(lang) ? `?lang=${lang}` : ""}`;
  if (!rateLimiter.take(`withdraw:${clientIp(await headers())}`, { max: 20, windowMs: 10 * 60_000 })) redirect(page);
  const booking = await store.getBookingByManageToken(token);
  // Anything other than a live request (already answered, lapsed) just shows the booking as it now stands.
  if (booking && booking.status === "pending_approval") await store.decideRequest(booking.hostId, booking.id, "withdraw", new Date());
  redirect(page);
}
