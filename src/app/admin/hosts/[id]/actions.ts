"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { setComplimentaryPlan, type PlanChangeRefused } from "@/lib/admin/plans";
import { requireStaff } from "@/lib/admin/session";

export async function setPlanAction(form: FormData): Promise<void> {
  const staff = await requireStaff("manage_plans");
  const hostId = String(form.get("hostId") ?? "");
  let outcome = "plan_saved";
  try {
    await setComplimentaryPlan(getPool(process.env.DATABASE_URL as string), staff, hostId, String(form.get("plan") ?? ""));
  } catch (error) {
    if (!isNamedError<PlanChangeRefused>(error, "PlanChangeRefused")) throw error;
    outcome = error.reason;
  }
  revalidatePath(`/admin/hosts/${hostId}`);
  redirect(`/admin/hosts/${encodeURIComponent(hostId)}?result=${outcome}`);
}
