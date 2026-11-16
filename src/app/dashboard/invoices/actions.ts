"use server";

import { revalidatePath } from "next/cache";
import { authEnabled } from "@/lib/auth/auth";
import { requireUser } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { removeTaxProfile, saveTaxProfile, validateTaxProfile, type TaxProfileErrors } from "@/lib/gst/invoices";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

export type TaxFormState = { status: "idle" } | { status: "saved" } | { status: "removed" } | { status: "error"; errors: Record<string, string> };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

const MESSAGES: Record<keyof TaxProfileErrors, HostKey> = {
  legalName: "invoices.errorLegalName",
  address: "invoices.errorAddress",
  gstin: "invoices.errorGstin",
  sac: "invoices.errorSac",
  rate: "invoices.errorRate",
  invoicePrefix: "invoices.errorPrefix",
};

/** Saves the signed-in host's GST details; invoices are issued from the next payment on. */
export async function saveTaxProfileAction(_prev: TaxFormState, form: FormData): Promise<TaxFormState> {
  const user = await requireUser();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", errors: { form: t("invoices.demo") } };
  if (form.get("remove") === "1") {
    await removeTaxProfile(getPool(process.env.DATABASE_URL as string), user.id);
    revalidatePath("/dashboard/invoices");
    return { status: "removed" };
  }
  const v = validateTaxProfile({
    legalName: field(form, "legalName"), address: field(form, "address"), gstin: field(form, "gstin"), sac: field(form, "sac"), rate: field(form, "rate"), invoicePrefix: field(form, "invoicePrefix"),
  });
  if (!v.ok) {
    const errors: Record<string, string> = {};
    for (const name of Object.keys(v.errors) as (keyof TaxProfileErrors)[]) errors[name] = t(MESSAGES[name]);
    // A well-formed prefix can only have been refused for starting with CN, which credit notes use.
    if (v.errors.invoicePrefix && /^[A-Z0-9]{1,4}$/.test(field(form, "invoicePrefix").trim().toUpperCase())) errors.invoicePrefix = t("invoices.errorPrefixCn");
    return { status: "error", errors };
  }
  await saveTaxProfile(getPool(process.env.DATABASE_URL as string), user.id, v.value);
  revalidatePath("/dashboard/invoices");
  return { status: "saved" };
}
