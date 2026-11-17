"use server";

import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { grantRole, revokeRole, type StaffChangeRefused } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";

export type StaffFormState = { status: "idle" } | { status: "done"; message: string } | { status: "error"; message: string };

const MESSAGES: Record<StaffChangeRefused["reason"], string> = {
  not_allowed: "Only a super admin can change staff.",
  no_account: "No Hourhand account uses that email. Ask them to sign in once at hourhand.cloud/sign-in, then add them.",
  fixed_by_env: "That super admin is set on the server (SUPER_ADMIN_EMAILS) and can't be changed here.",
  self: "You can't change your own role.",
  bad_role: "Pick Admin or Super admin.",
};

export async function grantStaffAction(_prev: StaffFormState, form: FormData): Promise<StaffFormState> {
  const staff = await requireStaff("manage_staff");
  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role") ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { status: "error", message: "Enter a valid email address." };
  try {
    const s = await grantRole(getPool(process.env.DATABASE_URL as string), staff, email, role);
    revalidatePath("/admin/staff");
    return { status: "done", message: `${s.email} is now ${role === "super_admin" ? "a super admin" : "an admin"}.` };
  } catch (error) {
    if (isNamedError<StaffChangeRefused>(error, "StaffChangeRefused")) return { status: "error", message: MESSAGES[error.reason] };
    throw error;
  }
}

export async function revokeStaffAction(form: FormData): Promise<void> {
  const staff = await requireStaff("manage_staff");
  try {
    await revokeRole(getPool(process.env.DATABASE_URL as string), staff, String(form.get("userId") ?? ""));
  } catch (error) {
    if (!isNamedError(error, "StaffChangeRefused")) throw error;
  }
  revalidatePath("/admin/staff");
}
