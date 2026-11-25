"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { REMINDER_CHOICES, saveReminderMinutes, validateReminderForm } from "@/lib/reminders";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Saves one event type's reminder times. The event type must be the signed-in host's own; anything else is "not found". */
export async function saveReminders(form: FormData): Promise<void> {
  const user = await requireHost();
  const id = String(form.get("eventTypeId") ?? "");
  if (!UUID.test(id) || !authEnabled()) redirect("/dashboard/event-types");
  const page = `/dashboard/event-types/${id}`;
  const fields = Object.fromEntries(REMINDER_CHOICES.map((m) => [`r${m}`, form.get(`r${m}`) === null ? undefined : String(form.get(`r${m}`))]));
  const v = validateReminderForm(fields);
  if (!v.ok) redirect(`${page}?reminders=too_many#reminders`);
  let target = `${page}?reminders=saved#reminders`;
  try {
    await saveReminderMinutes(getPool(process.env.DATABASE_URL as string), user.id, id, v.value, new Date());
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = "/dashboard/event-types";
  }
  revalidatePath(page);
  redirect(target);
}
