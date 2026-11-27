"use client";

import { useActionState } from "react";
import { makeApiKey, type ApiKeyFormState } from "@/app/dashboard/integrations/api-key-actions";
import { keyToShow } from "@/lib/api/show-key";
import type { HostKey } from "@/lib/i18n/host";
import { CopyLinkButton } from "./CopyLinkButton";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";

const idle: ApiKeyFormState = { status: "idle" };
const ERROR: Record<"name_missing" | "name_too_long" | "too_many", HostKey> = {
  name_missing: "integrations.apiNameMissing",
  name_too_long: "integrations.apiNameTooLong",
  too_many: "integrations.apiTooMany",
};

/** Names a new key and shows it once, right after it's made, and only while that key still exists (`keyIds`). */
export function ApiKeyForm({ max, canAdd, keyIds }: { max: number; canAdd: boolean; keyIds: string[] }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(makeApiKey, idle);
  const shown = keyToShow(state, keyIds);
  return (
    <div className="mt-4 grid gap-3">
      {shown && (
        <div role="status" className="rounded-md border border-border p-3">
          <p className="font-semibold text-text">{t("integrations.apiMade")}</p>
          <code className="mt-2 block break-all rounded bg-surface px-2 py-1 text-text">{shown}</code>
          <div className="mt-2"><CopyLinkButton url={shown} label={t("integrations.apiCopy")} /></div>
        </div>
      )}
      {state.status === "error" && <p role="alert" className="text-danger">{t(ERROR[state.error], { n: max })}</p>}
      {canAdd && (
        <form action={action} className="grid gap-3">
          <div>
            <Label htmlFor="api-key-name">{t("integrations.apiName")}</Label>
            <Input id="api-key-name" name="name" type="text" required maxLength={60} autoComplete="off" />
            <p className="mt-1 text-sm text-text-muted">{t("integrations.apiNameHint")}</p>
          </div>
          <div><Button type="submit" loading={pending}>{t("integrations.apiMake")}</Button></div>
        </form>
      )}
    </div>
  );
}
