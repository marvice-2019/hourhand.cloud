"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/admin/session";
import { tokenKey } from "@/lib/crypto/seal";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { razorpayVerifier } from "@/lib/payments/host-razorpay";
import {
  parsePercent, PlatformPaymentsRefused, recordPayout, removePlatformRazorpay, savePlatformRazorpay, setDefaultCommissionBps, setHostPaymentSettings,
  type PaymentMode,
} from "@/lib/payments/platform";

// Super admin payment settings (B18). Each action checks the permission again here, never only by the page's forms.

const db = () => getPool(process.env.DATABASE_URL as string);

async function run(back: string, ok: string, work: () => Promise<void>): Promise<never> {
  let outcome = ok;
  try {
    await work();
  } catch (error) {
    if (!isNamedError<PlatformPaymentsRefused>(error, "PlatformPaymentsRefused")) throw error;
    outcome = error.code;
  }
  revalidatePath(back);
  redirect(`${back}?result=${encodeURIComponent(outcome)}`);
}

export async function saveGatewayAction(form: FormData): Promise<void> {
  const staff = await requireStaff("manage_payments");
  await run("/admin/payments", "gateway_saved", async () => {
    await savePlatformRazorpay(db(), tokenKey(), staff, String(form.get("keyId") ?? ""), String(form.get("keySecret") ?? ""), razorpayVerifier());
  });
}

export async function removeGatewayAction(): Promise<void> {
  const staff = await requireStaff("manage_payments");
  await run("/admin/payments", "gateway_removed", () => removePlatformRazorpay(db(), staff));
}

export async function setCommissionAction(form: FormData): Promise<void> {
  const staff = await requireStaff("manage_payments");
  const bps = parsePercent(String(form.get("commission") ?? ""));
  await run("/admin/payments", "commission_saved", () => setDefaultCommissionBps(db(), staff, bps ?? 0));
}

export async function recordPayoutAction(form: FormData): Promise<void> {
  const staff = await requireStaff("manage_payments");
  const rupees = String(form.get("amount") ?? "").trim();
  const amountMinor = /^\d{1,9}(\.\d{1,2})?$/.test(rupees) ? Math.round(Number(rupees) * 100) : Number.NaN;
  await run("/admin/payments", "payout_recorded", () =>
    recordPayout(db(), staff, String(form.get("hostId") ?? ""), amountMinor, String(form.get("reference") ?? "")));
}

export async function setHostPaymentsAction(form: FormData): Promise<void> {
  const staff = await requireStaff("manage_payments");
  const hostId = String(form.get("hostId") ?? "");
  await run(`/admin/hosts/${encodeURIComponent(hostId)}`, "payments_saved", () =>
    setHostPaymentSettings(db(), staff, hostId, {
      mode: String(form.get("mode") ?? "") as PaymentMode,
      commissionBps: parsePercent(String(form.get("commission") ?? "")),
      routeAccount: String(form.get("routeAccount") ?? "") || null,
    }));
}
