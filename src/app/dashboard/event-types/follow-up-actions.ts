"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { saveFollowUpSettings, validateFollowUpForm } from "@/lib/follow-ups/follow-ups";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Saves one event type's follow-ups. The event type must be the signed-in host's own; anything else is "not found". */
export async function saveFollowUps(form: FormData): Promise<void> {
  const user = await requireHost();
  const id = String(form.get("eventTypeId") ?? "");
  if (!UUID.test(id) || !authEnabled()) redirect("/dashboard/event-types");
  const page = `/dashboard/event-types/${id}`;
  const fields = Object.fromEntries(["thankYou", "feedback", "reviewAsk", "packageNudge", "delayHours"].map((k) => [k, form.get(k) === null ? undefined : String(form.get(k))]));
  const v = validateFollowUpForm(fields);
  if (!v.ok) redirect(`${page}?followups=bad_delay#follow-ups`);
  let target = `${page}?followups=saved#follow-ups`;
  try {
    await saveFollowUpSettings(getPool(process.env.DATABASE_URL as string), user.id, id, v.value, new Date());
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = "/dashboard/event-types";
  }
  revalidatePath(page);
  redirect(target);
}
