"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/auth/session";
import { clientKey } from "@/lib/clients";
import { store } from "@/lib/data";
import { isNamedError } from "@/lib/data/types";
import { MAX_NOTE } from "@/lib/privacy/notes";

const KEY = /^[0-9a-f]{20}$/;
const page = (key: string) => `/dashboard/clients/${key}`;

/**
 * Saves the account owner's note about one of their own clients (someone who has booked them). Notes are the owner's
 * alone: a Duo second person managing the account is sent away by requireOwnAccount.
 */
export async function saveClientNoteAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const key = String(form.get("key") ?? "");
  const note = String(form.get("note") ?? "");
  // The email comes from the host's own bookings, never from the form, so a note can only be about their own client.
  const email = (await store.listBookings(user.id)).map((b) => b.invitee.email).find((e) => clientKey(e) === key);
  if (!email) redirect("/dashboard/clients?error=not_found");
  if (note.length > MAX_NOTE) redirect(`${page(key)}?error=too_long`);
  await store.saveClientNote(user.id, email, note, user.id);
  revalidatePath(page(key));
  redirect(`${page(key)}?saved=1`);
}

/** The owner's session note on one booking, saved from the client file and back to it. Owner only, own bookings only. */
export async function saveSessionNoteFromFile(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const key = String(form.get("key") ?? "");
  const bookingId = String(form.get("bookingId") ?? "");
  const note = String(form.get("note") ?? "");
  if (!KEY.test(key)) redirect("/dashboard/clients?error=not_found");
  if (note.length > MAX_NOTE) redirect(`${page(key)}?error=session_too_long#b-${bookingId}`);
  try {
    await store.saveBookingNote(user.id, bookingId, note, user.id);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) redirect("/dashboard/clients?error=not_found");
    throw error;
  }
  revalidatePath(page(key));
  redirect(`${page(key)}?saved=session#b-${bookingId}`);
}

/** Keep the text of earlier note versions, or stop (which deletes the versions kept so far). Owner only. */
export async function setKeepVersionsAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const key = String(form.get("key") ?? "");
  await store.setKeepNoteVersions(user.id, form.get("keep") === "1");
  if (!KEY.test(key)) redirect("/dashboard/clients");
  revalidatePath(page(key));
  redirect(`${page(key)}?saved=versions`);
}
