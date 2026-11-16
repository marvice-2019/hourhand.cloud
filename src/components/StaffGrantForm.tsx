"use client";

import { useActionState } from "react";
import { grantStaffAction, type StaffFormState } from "@/app/admin/staff/actions";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const idle: StaffFormState = { status: "idle" };

export function StaffGrantForm() {
  const [state, action, pending] = useActionState(grantStaffAction, idle);
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div><Label htmlFor="st-email">Their Hourhand email</Label><Input id="st-email" name="email" type="email" autoComplete="off" required /></div>
      <div>
        <Label htmlFor="st-role">Role</Label>
        <select id="st-role" name="role" defaultValue="admin" className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
          <option value="admin">Admin: read-only support</option>
          <option value="super_admin">Super admin: also manages staff and reads the audit log</option>
        </select>
      </div>
      {state.status === "error" && <p className="text-danger" role="alert">{state.message}</p>}
      {state.status === "done" && <p className="text-success" role="status">{state.message}</p>}
      <div><Button type="submit" loading={pending}>Add to staff</Button></div>
    </form>
  );
}
