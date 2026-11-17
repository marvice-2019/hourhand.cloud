import { StaffGrantForm } from "@/components/StaffGrantForm";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { listStaff, ROLE_NAMES } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";
import { revokeStaffAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminStaffPage() {
  const me = await requireStaff("manage_staff");
  const staff = await listStaff(getPool(process.env.DATABASE_URL as string));
  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-xl text-text">Staff</h1>
      <p className="mt-2 text-text-muted">Admins can read the overview and hosts&apos; account details. Super admins can also add and remove staff and read the audit log. Everyone signs in at hourhand.cloud/sign-in with their own email.</p>
      <Card className="mt-6"><h2 className="mb-4 font-semibold text-text">Add someone</h2><StaffGrantForm /></Card>
      <ul className="mt-8 grid gap-3">
        {staff.map((s) => (
          <li key={s.userId}>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-text">{s.name || s.email} <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm font-normal text-text-muted">{ROLE_NAMES[s.role]}</span></p>
                <p className="text-sm text-text-muted">{s.email}{s.fromEnv ? " · set on the server" : s.grantedAt ? ` · added ${formatDate(s.grantedAt, "Asia/Kolkata")}${s.grantedBy ? ` by ${s.grantedBy}` : ""}` : ""}</p>
              </div>
              {!s.fromEnv && s.userId !== me.id && (
                <form action={revokeStaffAction}><input type="hidden" name="userId" value={s.userId} /><Button type="submit" variant="ghost" size="sm">Remove</Button></form>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
