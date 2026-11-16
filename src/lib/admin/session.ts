import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { authEnabled } from "../auth/auth";
import { getSignedInUser } from "../auth/session";
import { getPool } from "../data/pg-store";
import { can, staffRole, type Permission, type StaffRole } from "./roles";

export interface StaffContext { id: string; email: string; name: string | null; role: StaffRole }

/** The signed-in staff member, or null. One lookup per request. */
export const getStaff = cache(async (): Promise<StaffContext | null> => {
  if (!authEnabled()) return null;
  const user = await getSignedInUser();
  if (!user) return null;
  const role = await staffRole(getPool(process.env.DATABASE_URL as string), user);
  return role ? { id: user.id, email: user.email, name: user.name ?? null, role } : null;
});

/**
 * For every admin page and action. Signed out: to the sign-in page. Signed in without the permission: a plain 404,
 * so the admin area doesn't announce itself to hosts.
 */
export async function requireStaff(permission: Permission): Promise<StaffContext> {
  if (!authEnabled()) notFound();
  if (!(await getSignedInUser())) redirect("/sign-in");
  const staff = await getStaff();
  if (!staff || !can(staff.role, permission)) notFound();
  return staff;
}
