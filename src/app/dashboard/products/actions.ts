"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { refundOrder, saveProduct, type ProductInputError } from "@/lib/products/products";

// Digital products (B20). Each action checks the session itself, and every query takes the signed-in host's id, so another
// host's product or order is simply not found.

const back = (result: string, anchor = ""): never => {
  revalidatePath("/dashboard/products");
  redirect(`/dashboard/products?result=${encodeURIComponent(result)}${anchor}`);
};

/** Whether the host may charge: a paid plan and an account that can take the money (theirs, or Hourhand's under B18). */
async function canCharge(hostId: string): Promise<boolean> {
  const payments = requestPaymentDeps();
  if (!payments || (await payments.planFor(hostId)) === "free") return false;
  return Boolean(await (payments.collectFor ?? payments.authFor)(hostId));
}

export async function saveProductAction(form: FormData): Promise<void> {
  const user = await requireHost();
  if (!authEnabled()) back("demo");
  const rupees = String(form.get("price") ?? "").trim() || "0";
  const priceMinor = /^\d{1,6}(\.\d{1,2})?$/.test(rupees) ? Math.round(Number(rupees) * 100) : Number.NaN;
  const id = String(form.get("id") ?? "") || undefined;
  let result = "saved";
  let anchor = "";
  try {
    const p = await saveProduct(getPool(process.env.DATABASE_URL as string), user.id, {
      id, slug: String(form.get("slug") ?? ""), title: String(form.get("title") ?? ""), description: String(form.get("description") ?? ""),
      priceMinor, delivery: String(form.get("delivery") ?? ""), linkUrl: String(form.get("linkUrl") ?? ""), active: form.get("active") === "on",
    }, priceMinor > 0 ? await canCharge(user.id) : true);
    anchor = `#p-${p.id}`;
  } catch (error) {
    if (!isNamedError<ProductInputError>(error, "ProductInputError")) throw error;
    result = `invalid_${Object.keys(error.fields)[0]}`;
    if (id) anchor = `#p-${id}`;
  }
  back(result, anchor);
}

export async function refundAction(form: FormData): Promise<void> {
  const user = await requireHost();
  if (!authEnabled()) back("demo");
  back(await refundOrder(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("id") ?? ""), new Date()), "#orders");
}
