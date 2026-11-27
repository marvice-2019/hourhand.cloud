"use server";

import { revalidatePath } from "next/cache";
import { setRequireApproval } from "@/lib/admin/review";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";

/** B17: switches whether new hosts wait for a super admin's approval. Checked here, not only by the form. */
export async function setRequireApprovalAction(form: FormData): Promise<void> {
  const staff = await requireStaff("review_hosts");
  await setRequireApproval(getPool(process.env.DATABASE_URL as string), staff, form.get("on") === "1");
  revalidatePath("/admin");
}
