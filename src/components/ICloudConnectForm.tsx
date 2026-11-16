"use client";

import { useActionState } from "react";
import { connectICloudAction, type ICloudFormState } from "@/app/dashboard/calendars/actions";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { useHostI18n } from "./HostI18nProvider";

const idle: ICloudFormState = { status: "idle" };

/** Apple has no sign-in button for calendars: the host gives an app-specific password, which works only for this. */
export function ICloudConnectForm() {
  const [state, action, pending] = useActionState(connectICloudAction, idle);
  const { t, tNodes } = useHostI18n();
  return (
    <form action={action} className="grid max-w-md gap-3">
      <p className="text-sm text-text-muted">
        {tNodes("calendars.icloudHowTo", {
          link: (
            // i18n-ignore: a web address, the same in every language
            <a href="https://account.apple.com/account/manage" className="font-semibold text-accent underline" rel="noopener noreferrer" target="_blank">account.apple.com</a>
          ),
        })}
      </p>
      <div><Label htmlFor="ic-id">{t("calendars.icloudAppleId")}</Label><Input id="ic-id" name="appleId" type="email" autoComplete="username" required /></div>
      <div>
        <Label htmlFor="ic-pw">{t("calendars.icloudPassword")}</Label>
        <Input id="ic-pw" name="password" type="password" autoComplete="off" required placeholder="xxxx-xxxx-xxxx-xxxx" // i18n-ignore: the shape of the password, not words
          error={state.status === "error" ? state.error : undefined} />
      </div>
      <div><Button type="submit" loading={pending}>{t("calendars.connectICloud")}</Button></div>
    </form>
  );
}
