import Link from "next/link";
import { Fragment } from "react";
import { Card } from "@/components/ui/Card";
import { LocalTime } from "@/components/LocalTime";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { formatDate, zoneName } from "@/lib/format";
import type { Locale } from "@/lib/i18n/guest";
import { refusalLines, splitTemplate, type RefusalReason } from "@/lib/video/messages";

// What someone sees when a join link can't open the call right now: the guest in their language, the host in English
// (like the dashboard).

export const JOIN_METADATA = { title: "Hourhand video", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export function JoinRefused({ reason, opensAt, tz, locale, back, switcherPath }: {
  reason: RefusalReason; opensAt?: Date; tz: string; locale: Locale; back?: { href: string; label?: string }; switcherPath?: string;
}) {
  const lines = refusalLines(locale);
  const msg = lines[reason];
  const slots = opensAt ? {
    date: formatDate(opensAt, tz, locale),
    time: <LocalTime date={opensAt} tz={tz} locale={locale} />,
    zone: zoneName(tz),
  } : null;
  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      {switcherPath && <LanguageSwitcher locale={locale} path={switcherPath} />}
      <h1 className="font-display text-xl text-text">{msg.title}</h1>
      <Card className="mt-4 max-w-md">
        <p className="text-text">{msg.body}</p>
        {reason === "too_early" && slots && (
          <p className="mt-2 text-text">
            {splitTemplate(lines.opensAt).map((p, i) => <Fragment key={i}>{p.slot ? slots[p.slot as keyof typeof slots] : p.text}</Fragment>)}
          </p>
        )}
      </Card>
      {back && <Link href={back.href} className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{back.label ?? lines.seeBooking}</Link>}
    </main>
  );
}
