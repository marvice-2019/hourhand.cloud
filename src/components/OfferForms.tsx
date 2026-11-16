"use client";

import { useActionState } from "react";
import {
  createCampaignAction, createCouponAction, saveFirstSessionAction, saveSlidingAction, type OfferFormState,
} from "@/app/dashboard/offers/actions";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const idle: OfferFormState = { status: "idle" };
const select = `mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;

type Item = { id: string; name: string };

function Outcome({ state }: { state: OfferFormState }) {
  if (state.status === "saved") return <p className="text-success" role="status">{state.message}</p>;
  if (state.status === "error" && state.errors.form) return <p className="text-danger" role="alert">{state.errors.form}</p>;
  return null;
}

/** Percent or rupees off. */
function DiscountFields({ prefix, errors, kind = "percent", value = "" }: { prefix: string; errors: Record<string, string>; kind?: string; value?: string }) {
  const { t } = useHostI18n();
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <Label htmlFor={`${prefix}-kind`}>{t("offers.discount")}</Label>
        <select id={`${prefix}-kind`} name="kind" defaultValue={kind} className={select}>
          <option value="percent">{t("offers.percentOffOption")}</option>
          <option value="fixed">{t("offers.rupeesOffOption")}</option>
        </select>
      </div>
      <div><Label htmlFor={`${prefix}-value`}>{t("offers.amount")}</Label><Input id={`${prefix}-value`} name="value" inputMode="decimal" defaultValue={value} placeholder="20" error={errors.value ?? errors.kind} /></div>
    </div>
  );
}

/** Which paid event types and packages an offer is for; none ticked means all of them. */
function ItemPicker({ prefix, eventTypes, packages }: { prefix: string; eventTypes: Item[]; packages: Item[] }) {
  const { t } = useHostI18n();
  if (eventTypes.length + packages.length === 0) return null;
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-text">{t("offers.forLegend")}</legend>
      <div className="mt-2 grid gap-1">
        {eventTypes.map((e) => (
          <label key={e.id} className="flex min-h-11 items-center gap-2 text-text"><input type="checkbox" name="eventTypeIds" value={e.id} id={`${prefix}-e-${e.id}`} className="size-5 accent-accent" />{e.name}</label>
        ))}
        {packages.map((p) => (
          <label key={p.id} className="flex min-h-11 items-center gap-2 text-text"><input type="checkbox" name="packageIds" value={p.id} id={`${prefix}-p-${p.id}`} className="size-5 accent-accent" />{t("offers.packageName", { name: p.name })}</label>
        ))}
      </div>
    </fieldset>
  );
}

export function CouponForm({ eventTypes, packages }: { eventTypes: Item[]; packages: Item[] }) {
  const [state, action, pending] = useActionState(createCouponAction, idle);
  const errors = state.status === "error" ? state.errors : {};
  const { t } = useHostI18n();
  return (
    <form action={action} className="grid max-w-md gap-4">
      {/* i18n-ignore: DIWALI20 is a sample code, the same in every language */}
      <div><Label htmlFor="cp-code">{t("offers.code")}</Label><Input id="cp-code" name="code" maxLength={32} placeholder="DIWALI20" autoCapitalize="characters" error={errors.code} /></div>
      <DiscountFields prefix="cp" errors={errors} />
      <div><Label htmlFor="cp-expires">{t("offers.lastDayWorks")}</Label><Input id="cp-expires" name="expiresOn" type="date" className="max-w-48" error={errors.expiresOn} /></div>
      <div className="grid grid-cols-2 gap-4">
        <div><Label htmlFor="cp-max">{t("offers.totalUses")}</Label><Input id="cp-max" name="maxUses" inputMode="numeric" placeholder="50" error={errors.maxUses} /></div>
        <div><Label htmlFor="cp-per">{t("offers.usesPerClient")}</Label><Input id="cp-per" name="maxUsesPerEmail" inputMode="numeric" placeholder="1" error={errors.maxUsesPerEmail} /></div>
      </div>
      <ItemPicker prefix="cp" eventTypes={eventTypes} packages={packages} />
      <Outcome state={state} />
      <div><Button type="submit" loading={pending}>{t("offers.createCode")}</Button></div>
    </form>
  );
}

export function CampaignForm({ eventTypes, packages, today }: { eventTypes: Item[]; packages: Item[]; today: string }) {
  const [state, action, pending] = useActionState(createCampaignAction, idle);
  const errors = state.status === "error" ? state.errors : {};
  const { t } = useHostI18n();
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div><Label htmlFor="cm-name">{t("offers.name")}</Label><Input id="cm-name" name="name" maxLength={60} placeholder={t("offers.namePlaceholder")} error={errors.name} /></div>
      <div><Label htmlFor="cm-banner">{t("offers.banner")}</Label><Input id="cm-banner" name="banner" maxLength={200} placeholder={t("offers.bannerPlaceholder")} error={errors.banner} /></div>
      <DiscountFields prefix="cm" errors={errors} />
      <div className="grid grid-cols-2 gap-4">
        <div><Label htmlFor="cm-start">{t("offers.firstDay")}</Label><Input id="cm-start" name="startsOn" type="date" min={today} defaultValue={today} error={errors.startsOn} /></div>
        <div><Label htmlFor="cm-end">{t("offers.lastDay")}</Label><Input id="cm-end" name="endsOn" type="date" min={today} error={errors.endsOn} /></div>
      </div>
      <ItemPicker prefix="cm" eventTypes={eventTypes} packages={packages} />
      <Outcome state={state} />
      <div><Button type="submit" loading={pending}>{t("offers.scheduleCampaign")}</Button></div>
    </form>
  );
}

export function FirstSessionForm({ current }: { current: { kind: string; value: string; active: boolean } | null }) {
  const [state, action, pending] = useActionState(saveFirstSessionAction, idle);
  const errors = state.status === "error" ? state.errors : {};
  const { t } = useHostI18n();
  return (
    <form action={action} className="grid max-w-md gap-4">
      <DiscountFields prefix="fs" errors={errors} kind={current?.kind} value={current?.value} />
      <label className="flex min-h-11 items-center gap-2 text-text">
        <input type="checkbox" name="active" defaultChecked={current?.active ?? true} className="size-5 accent-accent" />
        {t("offers.onForNew")}
      </label>
      <Outcome state={state} />
      <div><Button type="submit" loading={pending}>{t("common.save")}</Button></div>
    </form>
  );
}

export function SlidingForm({ eventTypeId, current }: { eventTypeId: string; current: { min: string; suggested: string; max: string; note: string } | null }) {
  const [state, action, pending] = useActionState(saveSlidingAction, idle);
  const errors = state.status === "error" ? state.errors : {};
  const { t } = useHostI18n();
  const p = `sl-${eventTypeId}`;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="eventTypeId" value={eventTypeId} />
      <div className="grid grid-cols-3 gap-3">
        <div><Label htmlFor={`${p}-min`}>{t("offers.lowest")}</Label><Input id={`${p}-min`} name="min" inputMode="decimal" defaultValue={current?.min} error={errors.min} /></div>
        <div><Label htmlFor={`${p}-sug`}>{t("offers.suggested")}</Label><Input id={`${p}-sug`} name="suggested" inputMode="decimal" defaultValue={current?.suggested} error={errors.suggested} /></div>
        <div><Label htmlFor={`${p}-max`}>{t("offers.highest")}</Label><Input id={`${p}-max`} name="max" inputMode="decimal" defaultValue={current?.max} error={errors.max} /></div>
      </div>
      <div>
        <Label htmlFor={`${p}-note`}>{t("offers.explanation")}</Label>
        <textarea id={`${p}-note`} name="note" rows={2} maxLength={500} defaultValue={current?.note}
          placeholder={t("offers.explanationPlaceholder")}
          className={`mt-1 block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} />
        {errors.note && <p className="mt-1 text-sm text-danger">{errors.note}</p>}
      </div>
      <Outcome state={state} />
      <div><Button type="submit" size="sm" loading={pending}>{current ? t("offers.saveRange") : t("offers.turnOnSliding")}</Button></div>
    </form>
  );
}
