"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { store } from "@/lib/data";
import { requireHost } from "@/lib/auth/session";

/** Points an event type at one of the host's schedules. The store checks both belong to the signed-in host. */
export async function setEventTypeScheduleAction(form: FormData): Promise<void> {
  const user = await requireHost();
  const id = String(form.get("event-type") ?? "");
  const eventType = await store.setEventTypeSchedule(user.id, id, String(form.get("schedule") ?? ""));
  revalidatePath("/dashboard/event-types");
  revalidatePath("/dashboard/availability");
  revalidatePath(`/${user.slug}`, "layout");
  redirect(`/dashboard/event-types/${eventType.id}?schedule=saved`);
}
