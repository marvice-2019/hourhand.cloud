"use client";

import { useSyncExternalStore } from "react";
import { openPortalAction } from "@/app/[slug]/portal/actions";
import { Button } from "@/components/ui/Button";
import type { Locale } from "@/lib/i18n/guest";
import { pt } from "@/lib/i18n/portal";

// The link's token travels in the URL fragment (#…), which browsers never send to a server: it stays out of logs and
// Referer headers, and a mail scanner that fetches the link can't use it up. It is posted only when the client taps.
const readHash = () => decodeURIComponent(window.location.hash.slice(1));
const subscribe = (onChange: () => void) => { window.addEventListener("hashchange", onChange); return () => window.removeEventListener("hashchange", onChange); };

export function OpenPortalForm({ slug, hostName, locale }: { slug: string; hostName: string; locale: Locale }) {
  const token = useSyncExternalStore(subscribe, readHash, () => null);
  if (token === null) return null;
  if (!token) return <p role="alert" className="text-danger">{pt(locale, "openMissing")}</p>;
  return (
    <form action={openPortalAction} className="grid gap-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lang" value={locale} />
      <input type="hidden" name="token" value={token} />
      <p className="text-text">{pt(locale, "openBody", { host: hostName })}</p>
      <Button type="submit">{pt(locale, "openButton")}</Button>
    </form>
  );
}
