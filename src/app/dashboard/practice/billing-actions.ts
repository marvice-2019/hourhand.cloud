"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { billingFor } from "@/lib/billing/env";
import { changeClinicPlaces, startClinicCheckout, type ClinicBillingError } from "@/lib/clinic/billing";
import type { ClinicAccessError } from "@/lib/clinic/roles";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";

// The Clinic subscription is the practice owner's own: every action works from the signed-in person's own account and
// the library checks they own the practice ("billing.manage") before calling Razorpay.

const pool = () => getPool(process.env.DATABASE_URL as string);
const baseUrl = () => (resolveBaseUrl() ?? "http://localhost:3000").replace(/\/+$/, "");
const deps = () => ({ api: billingFor("razorpay")?.api ?? null });

async function run(fn: () => Promise<string | void>, done: string): Promise<never> {
  if (!authEnabled()) redirect("/dashboard/plan?clinic_error=demo");
  let target = `/dashboard/plan?clinic_done=${done}`;
  try {
    const url = await fn();
    if (url) target = url;
  } catch (e) {
    if (isNamedError<ClinicBillingError>(e, "ClinicBillingError")) target = `/dashboard/plan?clinic_error=${e.code}`;
    else if (isNamedError<ClinicAccessError>(e, "ClinicAccessError")) target = "/dashboard/plan?clinic_error=not_owner";
    else throw e;
  }
  revalidatePath("/dashboard", "layout");
  redirect(target);
}

const count = (form: FormData) => Number.parseInt(String(form.get("practitioners") ?? ""), 10);

export async function startClinicAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  await run(() => startClinicCheckout(pool(), user, count(form), baseUrl(), deps()), "checkout");
}

/** Switches Solo or Duo to Clinic, or changes how many practitioner places Clinic pays for. */
export async function changeClinicAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  await run(() => changeClinicPlaces(pool(), user, count(form), deps()), "changed");
}
