"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { getHostI18n } from "@/lib/i18n/host/server";
import { formatAmount } from "@/lib/money";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { createPackage, PACKAGE_LIMITS, setPackageActive, validatePackageForm } from "@/lib/packages/packages";

// Each action checks the session itself; every query takes the signed-in host's id, so another host's package or event
// type is simply not found.

export type PackageFormState = { status: "idle" } | { status: "created" } | { status: "error"; errors: Record<string, string> };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function createPackageAction(_prev: PackageFormState, form: FormData): Promise<PackageFormState> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", errors: { form: t("packages.demo") } };
  const v = validatePackageForm({ eventTypeId: field(form, "eventTypeId"), name: field(form, "name"), sessions: field(form, "sessions"), price: field(form, "price"), validDays: field(form, "validDays") });
  if (!v.ok) {
    const { sessions: s, validDays: d } = PACKAGE_LIMITS;
    // A Stripe host prices in their Stripe account's currency, so the bad-price hint names that currency, not rupees.
    const currency = v.errors.price && authEnabled() ? priceCurrency(await paymentAccount(getPool(process.env.DATABASE_URL as string), user.id)) : "INR";
    const messages = {
      eventTypeId: t("packages.errorEventType"),
      name: t("packages.errorName"),
      sessions: t("packages.errorSessions", { min: s.min, max: s.max }),
      price: currency === "INR" ? t("packages.errorPrice") : t("common.errPriceOther", { currency, min: formatAmount(100, currency) }),
      validDays: t("packages.errorValidDays", { min: d.min, max: d.max }),
    };
    const errors: Record<string, string> = {};
    for (const name of Object.keys(v.errors) as (keyof typeof messages)[]) errors[name] = messages[name];
    return { status: "error", errors };
  }
  try {
    const pool = getPool(process.env.DATABASE_URL as string);
    await createPackage(pool, user.id, { ...v.value, currency: priceCurrency(await paymentAccount(pool, user.id)) });
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { eventTypeId: t("packages.eventTypeUnavailable") } };
    throw error;
  }
  revalidatePath("/dashboard/packages");
  return { status: "created" };
}

export async function togglePackage(form: FormData): Promise<void> {
  const user = await requireHost();
  let target = "/dashboard/packages";
  try {
    await setPackageActive(getPool(process.env.DATABASE_URL as string), user.id, field(form, "packageId"), field(form, "active") === "on");
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = "/dashboard/packages?error=not_found";
  }
  revalidatePath("/dashboard/packages");
  redirect(target);
}
