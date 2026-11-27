"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { setComplimentaryPlan, type PlanChangeRefused } from "@/lib/admin/plans";
import { setHostReview, type HostReviewRefused } from "@/lib/admin/review";
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

/** Approve, decline, suspend or reactivate a host (B17). Checked here again, never only by the page's buttons. */
export async function reviewHostAction(form: FormData): Promise<void> {
  const staff = await requireStaff("review_hosts");
  const hostId = String(form.get("hostId") ?? "");
  const action = String(form.get("action") ?? "");
  let outcome = `review_${action}`;
  try {
    await setHostReview(getPool(process.env.DATABASE_URL as string), staff, hostId, action);
  } catch (error) {
    if (!isNamedError<HostReviewRefused>(error, "HostReviewRefused")) throw error;
    outcome = `review_${error.reason}`;
  }
  revalidatePath(`/admin/hosts/${hostId}`);
  redirect(`/admin/hosts/${encodeURIComponent(hostId)}?result=${encodeURIComponent(outcome)}`);
}
