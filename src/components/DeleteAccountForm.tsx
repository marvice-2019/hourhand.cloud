"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { deleteMyAccount, type DeleteAccountState } from "@/lib/auth/actions";
import { DELETE_ACCOUNT_MESSAGES } from "@/lib/auth/delete-account-messages";
import { translator } from "@/lib/i18n/host/lib-messages";
import { useHostI18n } from "./HostI18nProvider";

// deleteMyAccount words its errors in English; each is shown as the same line in the host's language.
const say = translator(DELETE_ACCOUNT_MESSAGES, { demo: "settings.errDeleteDemo", email: "settings.errDeleteEmail", phone: "settings.errDeletePhone" });

/** `phone` is set for a phone sign-up: they confirm with their number, since their email is only a placeholder. */
export function DeleteAccountForm({ email, phone }: { email: string; phone?: string }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState<DeleteAccountState, FormData>(deleteMyAccount, {});
  const error = state.error ? say(t, state.error) : undefined;
  return (
    <form action={action} className="mt-4 grid gap-4">
      <div>
        <Label htmlFor="confirm-email">{phone ? t("settings.deleteConfirmPhone", { phone }) : t("settings.deleteConfirm", { email })}</Label>
        <Input id="confirm-email" name="confirm-email" type={phone ? "tel" : "email"} autoComplete="off" required error={error} />
      </div>
      <Button type="submit" variant="danger" loading={pending} className="justify-self-start">
        {t("settings.deleteButton")}
      </Button>
    </form>
  );
}
