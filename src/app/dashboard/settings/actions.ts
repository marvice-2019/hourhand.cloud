"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/auth/session";
import { store } from "@/lib/data";
import { isLocale } from "@/lib/i18n/guest";
import { authEnabled } from "@/lib/auth/auth";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { setPrep } from "@/lib/session-prep/prep";

/** The language guests see on the host's booking pages unless they pick another. */
export async function setBookingLanguage(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const locale = form.get("locale");
  if (!isLocale(locale)) redirect("/dashboard/settings");
  await store.setUserLocale(user.id, locale);
  revalidatePath(`/${user.slug}`, "layout");
  redirect("/dashboard/settings?saved=language");
}

/** Session prep briefs on or off. Turning on needs the box ticked that says what is sent to Anthropic. */
export async function setSessionPrep(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/settings");
  const on = form.get("enabled") === "on";
  if (on && form.get("agree") !== "on") redirect("/dashboard/settings?error=prep_agree#session-prep");
  const pool = getPool(process.env.DATABASE_URL as string);
  if (on && !LIMITS[await hostPlan(pool, user.id)].sessionPrep) redirect("/dashboard/settings?error=prep_plan#session-prep");
  await setPrep(pool, user.id, on, new Date());
  redirect(`/dashboard/settings?saved=${on ? "prep_on" : "prep_off"}#session-prep`);
}
