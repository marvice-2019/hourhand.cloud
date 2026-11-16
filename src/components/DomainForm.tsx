"use client";

import { useActionState } from "react";
import { saveDomain, type DomainFormState } from "@/app/dashboard/domain/actions";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";

const idle: DomainFormState = { status: "idle" };

export function DomainForm({ current }: { current?: string }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(saveDomain, idle);
  return (
    <form action={action} className="grid max-w-md gap-3">
      <div>
        <Label htmlFor="domain">{current ? t("domain.labelChange") : t("domain.labelNew")}</Label>
        <Input id="domain" name="domain" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} required
          placeholder={t("domain.exampleDomain")} defaultValue="" error={state.status === "error" ? state.error : undefined} />
      </div>
      <div><Button type="submit" loading={pending}>{current ? t("domain.useInstead") : t("domain.add")}</Button></div>
    </form>
  );
}
