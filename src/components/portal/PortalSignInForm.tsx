"use client";

import { useActionState } from "react";
import { requestLinkAction, type PortalRequestState } from "@/app/[slug]/portal/actions";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import type { Locale } from "@/lib/i18n/guest";
import { pt } from "@/lib/i18n/portal";

const initial: PortalRequestState = { status: "idle" };

export function PortalSignInForm({ slug, hostName, locale }: { slug: string; hostName: string; locale: Locale }) {
  const [state, action, pending] = useActionState(requestLinkAction, initial);

  if (state.status === "sent") {
    return (
      <div role="status" className="rounded-md bg-surface p-4">
        <p className="font-semibold text-text">{pt(locale, "sentHeading")}</p>
        <p className="mt-1 text-text-muted">{pt(locale, "sentBody", { email: state.email ?? "", host: hostName })}</p>
      </div>
    );
  }

  const error = state.status === "invalid_email" ? pt(locale, "invalidEmail") : state.status === "too_many" ? pt(locale, "tooMany")
    : state.status === "unavailable" ? pt(locale, "unavailable") : undefined;
  return (
    <form action={action} noValidate className="grid gap-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lang" value={locale} />
      <div>
        <Label htmlFor="portal-email">{pt(locale, "email")}</Label>
        <Input id="portal-email" name="email" type="email" autoComplete="email" inputMode="email" required defaultValue={state.email} error={error} />
      </div>
      <Button type="submit" loading={pending}>{pt(locale, "sendLink")}</Button>
    </form>
  );
}
