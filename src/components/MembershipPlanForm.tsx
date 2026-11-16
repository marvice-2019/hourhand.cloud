"use client";

import { useActionState, useState } from "react";
import { createMembershipPlanAction, type MembershipFormState } from "@/app/dashboard/memberships/actions";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";
import { useHostI18n } from "./HostI18nProvider";

const idle: MembershipFormState = { status: "idle" };
/** RBI: recurring debits above this need the client's OTP / UPI PIN every month. */
const AFA_FREE_RUPEES = 15_000;

export function MembershipPlanForm({ eventTypes }: { eventTypes: { id: string; name: string }[] }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(createMembershipPlanAction, idle);
  const [rollover, setRollover] = useState("none");
  const [price, setPrice] = useState("");
  const errors = state.status === "error" ? state.errors : {};
  if (eventTypes.length === 0) return <p className="text-text-muted">{t("memberships.needEventType")}</p>;
  const overLimit = Number(price) > AFA_FREE_RUPEES;
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div><Label htmlFor="mb-name">{t("memberships.name")}</Label><Input id="mb-name" name="name" maxLength={100} placeholder={t("memberships.namePlaceholder")} error={errors.name} /></div>
      <div className="grid grid-cols-2 gap-4">
        <div><Label htmlFor="mb-sessions">{t("memberships.sessionsMonth")}</Label><Input id="mb-sessions" name="sessions" inputMode="numeric" defaultValue="4" error={errors.sessions} /></div>
        <div><Label htmlFor="mb-price">{t("memberships.priceMonth")}</Label><Input id="mb-price" name="price" inputMode="decimal" placeholder="6000" value={price} onChange={(e) => setPrice(e.target.value)} error={errors.price} /></div>
      </div>
      {overLimit && (
        <p className="text-sm text-text-muted" role="status">{t("memberships.afaWarning")}</p>
      )}
      <fieldset>
        <legend className="text-sm font-medium text-text">{t("memberships.sessionsFor")}</legend>
        <div className="mt-2 grid gap-2">
          {eventTypes.map((et) => (
            <label key={et.id} className="flex items-center gap-2 text-text">
              <input type="checkbox" name="eventTypeIds" value={et.id} defaultChecked={eventTypes.length === 1} className={focusRing} /> {et.name}
            </label>
          ))}
        </div>
        {errors.eventTypeIds && <p className="mt-1 text-sm text-danger">{errors.eventTypeIds}</p>}
      </fieldset>
      <div>
        <Label htmlFor="mb-rollover">{t("memberships.rolloverLabel")}</Label>
        <select id="mb-rollover" name="rollover" value={rollover} onChange={(e) => setRollover(e.target.value)}
          className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
          <option value="none">{t("memberships.rolloverOptNone")}</option>
          <option value="capped">{t("memberships.rolloverOptCapped")}</option>
          <option value="unlimited">{t("memberships.rolloverOptUnlimited")}</option>
        </select>
        {errors.rollover && <p className="mt-1 text-sm text-danger">{errors.rollover}</p>}
      </div>
      {rollover === "capped" && (
        <div><Label htmlFor="mb-cap">{t("memberships.keepAtMost")}</Label><Input id="mb-cap" name="rolloverCap" inputMode="numeric" defaultValue="4" className="max-w-32" error={errors.rolloverCap} /></div>
      )}
      {errors.form && <p className="text-danger" role="alert">{errors.form}</p>}
      {state.status === "created" && <p className="text-success" role="status">{t("memberships.created")}</p>}
      <div><Button type="submit" loading={pending}>{t("memberships.create")}</Button></div>
    </form>
  );
}
