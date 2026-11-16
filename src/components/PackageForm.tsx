"use client";

import { useActionState } from "react";
import { currencyLabel } from "@/lib/money";
import { createPackageAction, type PackageFormState } from "@/app/dashboard/packages/actions";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const idle: PackageFormState = { status: "idle" };

export function PackageForm({ eventTypes, currency = "INR" }: { eventTypes: { id: string; name: string }[]; currency?: string }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(createPackageAction, idle);
  const errors = state.status === "error" ? state.errors : {};
  if (eventTypes.length === 0) return <p className="text-text-muted">{t("packages.needEventType")}</p>;
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div>
        <Label htmlFor="pk-event">{t("packages.sessionsOf")}</Label>
        <select id="pk-event" name="eventTypeId" defaultValue={eventTypes[0].id} className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
          {eventTypes.map((et) => <option key={et.id} value={et.id}>{et.name}</option>)}
        </select>
        {errors.eventTypeId && <p className="mt-1 text-sm text-danger">{errors.eventTypeId}</p>}
      </div>
      <div><Label htmlFor="pk-name">{t("packages.name")}</Label><Input id="pk-name" name="name" maxLength={100} placeholder={t("packages.namePlaceholder")} error={errors.name} /></div>
      <div className="grid grid-cols-2 gap-4">
        <div><Label htmlFor="pk-sessions">{t("packages.sessions")}</Label><Input id="pk-sessions" name="sessions" inputMode="numeric" defaultValue="5" error={errors.sessions} /></div>
        <div><Label htmlFor="pk-price">{t("packages.price", { currency: currencyLabel(currency) })}</Label><Input id="pk-price" name="price" inputMode="decimal" placeholder="4999" error={errors.price} /></div>
      </div>
      <div>
        <Label htmlFor="pk-days">{t("packages.validDays")}</Label>
        <Input id="pk-days" name="validDays" inputMode="numeric" defaultValue="90" className="max-w-32" error={errors.validDays} />
      </div>
      {errors.form && <p className="text-danger" role="alert">{errors.form}</p>}
      {state.status === "created" && <p className="text-success" role="status">{t("packages.created")}</p>}
      <div><Button type="submit" loading={pending}>{t("packages.create")}</Button></div>
    </form>
  );
}
