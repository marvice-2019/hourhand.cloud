"use client";

import { useActionState } from "react";
import { inviteSeatAction, removeSeatAction, type SeatFormState } from "@/app/dashboard/seat/actions";
import type { Seat } from "@/lib/seats";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";

const idle: SeatFormState = { status: "idle" };

export function SeatForm({ seat }: { seat: Seat | null }) {
  const [state, action, pending] = useActionState(inviteSeatAction, idle);
  const { t, tNodes } = useHostI18n();
  return (
    <div className="grid gap-4">
      {seat && (
        <form action={removeSeatAction} className="flex flex-wrap items-center gap-3">
          <p className="text-text">
            {seat.accepted ? tNodes("seat.isSecondPerson", { name: <span className="font-semibold">{seat.memberName ?? seat.email}</span>, email: seat.email })
              : tNodes("seat.invitationPending", { email: <span className="font-semibold">{seat.email}</span> })}
          </p>
          <Button type="submit" variant="secondary" size="sm">{t("common.remove")}</Button>
        </form>
      )}
      <form action={action} className="grid max-w-md gap-2">
        <Label htmlFor="seat-email">{seat ? t("seat.inviteSomeoneElse") : t("seat.theirEmail")}</Label>
        <Input id="seat-email" name="email" type="email" autoComplete="off" required error={state.status === "error" ? state.error : undefined} />
        {state.status === "invited" && <p role="status" className="text-sm text-success">{t("seat.invited")}</p>}
        <div><Button type="submit" loading={pending}>{t("seat.sendInvitation")}</Button></div>
      </form>
    </div>
  );
}
