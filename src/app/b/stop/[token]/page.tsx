import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { optOutPage } from "@/lib/follow-ups/follow-ups";
import { linkKey } from "@/lib/follow-ups/tokens";
import { resolveLocale } from "@/lib/i18n/guest";
import { ft } from "@/lib/i18n/follow-up";
import { stopFollowUps } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Opening the link changes nothing (mail scanners open links); the one button does. Booking confirmations and
 * reminders keep coming: only the after-session emails stop.
 */
export default async function StopFollowUpsPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; lang?: string }> }) {
  if (!authEnabled()) notFound();
  const { token: raw } = await params;
  const { lang } = await searchParams;
  const token = decodeURIComponent(raw);
  let key: Buffer | null = null;
  try { key = linkKey(); } catch { /* no signing key: no link can be checked */ }
  const info = key ? await optOutPage(getPool(process.env.DATABASE_URL as string), key, token) : null;
  const locale = resolveLocale(lang, info?.hostLocale);
  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <Card className="max-w-md">
        {!info ? <>
          <h1 className="font-display text-xl text-text">{ft(locale, "invalidTitle")}</h1>
          <p className="mt-2 text-text-muted">{ft(locale, "invalidBody")}</p>
        </> : info.done ? (
          <p role="status" className="text-text">{ft(locale, "optOutDone", { host: info.hostName })}</p>
        ) : <>
          <h1 className="font-display text-xl text-text">{ft(locale, "optOutTitle", { host: info.hostName })}</h1>
          <p className="mt-2 text-text-muted">{ft(locale, "optOutBody")}</p>
          <form action={stopFollowUps} className="mt-6">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="lang" value={locale} />
            <Button type="submit">{ft(locale, "optOutButton")}</Button>
          </form>
        </>}
      </Card>
    </main>
  );
}
