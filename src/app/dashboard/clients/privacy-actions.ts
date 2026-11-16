"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { clientKey } from "@/lib/clients";
import { store } from "@/lib/data";
import { isNamedError } from "@/lib/data/types";
import { getPool } from "@/lib/data/pg-store";
import { eraseClient, resolveRequest, type ErasureBlockedError } from "@/lib/privacy/rights";

// Owner-only actions on a client's data. requireOwnAccount sends a Duo second person away before anything runs, and
// the client is looked up in the owner's own bookings, never taken from the form.

/**
 * Erases a client for good. The owner must type the client's email address exactly (any case) to confirm. Logged with
 * who and when (client_erasures), never whom.
 */
export async function eraseClientAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const key = String(form.get("key") ?? "");
  const typed = String(form.get("confirm") ?? "").trim().toLowerCase();
  const page = `/dashboard/clients/${encodeURIComponent(key)}`;
  if (!authEnabled()) redirect(`${page}?error=erase_unavailable`);
  const email = (await store.listBookings(user.id)).map((b) => b.invitee.email).find((e) => clientKey(e) === key);
  if (!email) redirect("/dashboard/clients?error=not_found");
  if (typed !== email.toLowerCase()) redirect(`${page}?error=confirm_mismatch#erase`);
  let blocked: string | null = null;
  try {
    await eraseClient(getPool(process.env.DATABASE_URL as string), user.id, user.id, email, new Date());
  } catch (error) {
    if (!isNamedError<ErasureBlockedError>(error, "ErasureBlockedError")) throw error;
    blocked = error.reason;
  }
  if (blocked) redirect(`${page}?error=erase_${blocked}#erase`);
  revalidatePath("/dashboard/clients");
  redirect("/dashboard/clients?erased=1");
}

/** Marks a guest's request done (the copy was sent) or declined. */
export async function resolveRequestAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const id = String(form.get("id") ?? "");
  const status = form.get("status") === "declined" ? "declined" : "done";
  const ok = authEnabled() && (await resolveRequest(getPool(process.env.DATABASE_URL as string), user.id, user.id, id, status, new Date()));
  revalidatePath("/dashboard/clients/requests");
  redirect(`/dashboard/clients/requests?${ok ? `resolved=${status}` : "error=not_found"}`);
}
