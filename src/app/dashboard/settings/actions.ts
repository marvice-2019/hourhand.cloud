"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/auth/session";
import { store } from "@/lib/data";
import { isLocale } from "@/lib/i18n/guest";
import { isHostLocale } from "@/lib/i18n/host";

/** The language guests see on the host's booking pages unless they pick another. */
export async function setBookingLanguage(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const locale = form.get("locale");
  if (!isLocale(locale)) redirect("/dashboard/settings");
  await store.setUserLocale(user.id, locale);
  revalidatePath(`/${user.slug}`, "layout");
  redirect("/dashboard/settings?saved=language");
}

/** The language of the host's own dashboard and the emails Hourhand sends them. Takes effect on the next page. */
export async function setDashboardLanguage(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const locale = form.get("hostLocale");
  if (!isHostLocale(locale)) redirect("/dashboard/settings");
  await store.setUserHostLocale(user.id, locale);
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/settings?saved=dashboard-language");
}
