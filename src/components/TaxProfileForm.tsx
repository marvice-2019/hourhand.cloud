"use client";

import { useActionState } from "react";
import { saveTaxProfileAction, type TaxFormState } from "@/app/dashboard/invoices/actions";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const idle: TaxFormState = { status: "idle" };

export function TaxProfileForm({ saved }: { saved: { legalName: string; address: string; gstin: string; sac: string; rateBp: number; invoicePrefix: string } | null }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(saveTaxProfileAction, idle);
  const errors = state.status === "error" ? state.errors : {};
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div><Label htmlFor="tx-name">{t("invoices.legalName")}</Label><Input id="tx-name" name="legalName" defaultValue={saved?.legalName} maxLength={200} error={errors.legalName} /></div>
      <div>
        <Label htmlFor="tx-address">{t("invoices.address")}</Label>
        <textarea id="tx-address" name="address" rows={3} maxLength={500} defaultValue={saved?.address}
          className={`mt-1 block w-full rounded-md border bg-card p-3 text-base text-text ${errors.address ? "border-danger" : "border-border-input"} ${focusRing}`} />
        {errors.address && <p className="mt-1 text-sm text-danger">{errors.address}</p>}
      </div>
      {/* i18n-ignore: the placeholder is a sample GSTIN */}
      <div><Label htmlFor="tx-gstin">GSTIN</Label><Input id="tx-gstin" name="gstin" defaultValue={saved?.gstin} maxLength={15} autoCapitalize="characters" placeholder="29ABCDE1234F1Z5" error={errors.gstin} /></div>
      <div className="grid grid-cols-2 gap-4">
        <div><Label htmlFor="tx-sac">{t("invoices.sac")}</Label><Input id="tx-sac" name="sac" inputMode="numeric" defaultValue={saved?.sac ?? "999293"} error={errors.sac} /></div>
        <div>
          <Label htmlFor="tx-rate">{t("invoices.rate")}</Label>
          <select id="tx-rate" name="rate" defaultValue={String((saved?.rateBp ?? 1800) / 100)} className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
            {[5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
          {errors.rate && <p className="mt-1 text-sm text-danger">{errors.rate}</p>}
        </div>
      </div>
      <div>
        <Label htmlFor="tx-prefix">{t("invoices.prefix")}</Label>
        <Input id="tx-prefix" name="invoicePrefix" defaultValue={saved?.invoicePrefix ?? "HH"} maxLength={4} className="max-w-32" autoCapitalize="characters" error={errors.invoicePrefix} />
        <p className="mt-1 text-sm text-text-muted">{t("invoices.prefixHint")}</p>
      </div>
      {errors.form && <p className="text-danger" role="alert">{errors.form}</p>}
      {state.status === "saved" && <p className="text-success" role="status">{t("invoices.saved")}</p>}
      {state.status === "removed" && <p className="text-text" role="status">{t("invoices.removed")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={pending}>{t("invoices.save")}</Button>
        {saved && <Button type="submit" name="remove" value="1" variant="ghost">{t("invoices.stop")}</Button>}
      </div>
    </form>
  );
}
