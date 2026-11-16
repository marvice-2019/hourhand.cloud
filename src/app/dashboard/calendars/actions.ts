"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireUser } from "@/lib/auth/session";
import { connectICloud, disconnectConnection, setAddToCalendar, setCheckConflicts } from "@/lib/calendar/connections";
import { calendarDeps } from "@/lib/calendar/env";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { kickJobs } from "@/lib/jobs/kick";

// Each action checks the session itself and changes only the signed-in host's own rows (enforced in the SQL).

const pool = () => getPool(process.env.DATABASE_URL as string);

export async function toggleConflictCheck(form: FormData): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) return;
  const on = form.get("on") === "1";
  const changed = await setCheckConflicts(pool(), user.id, String(form.get("calendarId")), on);
  if (!changed && on) redirect("/dashboard/calendars?error=calendar_limit");
  if (changed) {
    // Sync again now, so the slot engine sees the change within seconds.
    await pool().query("update calendar_connections set next_sync_at = now() where id = (select connection_id from calendars where id = $1 and user_id = $2)",
      [String(form.get("calendarId")), user.id]);
    kickJobs();
  }
  revalidatePath("/dashboard/calendars");
}

export async function useForBookings(form: FormData): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) return;
  await setAddToCalendar(pool(), user.id, String(form.get("calendarId")));
  revalidatePath("/dashboard/calendars");
}

export async function disconnectCalendar(form: FormData): Promise<void> {
  const user = await requireUser();
  if (!authEnabled()) return;
  const deps = calendarDeps();
  await disconnectConnection(pool(), deps?.providers ?? {}, deps?.key ?? null, user.id, String(form.get("connectionId")));
  revalidatePath("/dashboard/calendars");
  revalidatePath("/dashboard", "layout");
}

export type ICloudFormState = { status: "idle" } | { status: "error"; error: string };

const ICLOUD_ERRORS = {
  rejected: "calendars.icloudRejected",
  unreachable: "calendars.icloudUnreachable",
  no_calendars: "calendars.icloudNoCalendars",
} as const satisfies Record<string, HostKey>;

export async function connectICloudAction(_prev: ICloudFormState, form: FormData): Promise<ICloudFormState> {
  const user = await requireUser();
  const { t } = await getHostI18n();
  const deps = authEnabled() ? calendarDeps() : null;
  if (!deps?.providers.icloud) return { status: "error", error: t("calendars.icloudNotConfigured") };
  const appleId = String(form.get("appleId") ?? "").trim();
  const password = String(form.get("password") ?? "").replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleId) || password.length < 8) return { status: "error", error: t("calendars.icloudInvalid") };
  const result = await connectICloud(pool(), deps.key, deps.providers.icloud, user.id, appleId, password, new Date());
  if (result !== "ok") return { status: "error", error: t(ICLOUD_ERRORS[result]) };
  kickJobs();
  revalidatePath("/dashboard/calendars");
  redirect("/dashboard/calendars?connected=icloud");
}
