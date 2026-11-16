"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { setWhatsAppBooking } from "@/lib/whatsapp-booking";

// Turning "Book over WhatsApp" on or off for the signed-in host's own account only (not while managing someone else's).

async function set(on: boolean): Promise<never> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/integrations?error=demo");
  const pool = getPool(process.env.DATABASE_URL as string);
  if (on && !LIMITS[await hostPlan(pool, user.id)].whatsappBooking) redirect("/dashboard/plan");
  await setWhatsAppBooking(pool, user.id, on);
  revalidatePath("/dashboard/integrations");
  redirect(`/dashboard/integrations?whatsapp=${on ? "on" : "off"}#whatsapp-booking`);
}

export async function enableWhatsAppBooking(): Promise<void> {
  await set(true);
}

export async function disableWhatsAppBooking(): Promise<void> {
  await set(false);
}
