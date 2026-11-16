"use client";

import { useActionState } from "react";
import { addEmail, type AddEmailState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { useHostI18n } from "./HostI18nProvider";

/** A phone sign-up adds an email: a confirmation link goes to it, and the address is saved when that link is opened. */
export function AddEmailForm() {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState<AddEmailState, FormData>(addEmail, { status: "idle" });
  if (state.status === "sent") {
    return <p role="status" className="mt-4 rounded-md bg-surface p-3 text-sm text-text">{t("settings.addEmailSent", { email: state.email ?? "" })}</p>;
  }
  const error = state.status === "invalid" ? t("settings.errAddEmailInvalid") : state.status === "failed" ? t("settings.errAddEmailFailed") : undefined;
  return (
    <form action={action} noValidate className="mt-4 grid gap-4">
      <div>
        <Label htmlFor="add-email">{t("settings.addEmailLabel")}</Label>
        <Input id="add-email" name="email" type="email" autoComplete="email" inputMode="email" required defaultValue={state.email} error={error} />
      </div>
      <Button type="submit" loading={pending} className="justify-self-start">
        {t("settings.addEmailButton")}
      </Button>
    </form>
  );
}
