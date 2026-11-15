import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalTime } from "@/components/LocalTime";
import { formatDate, zoneName } from "@/lib/format";
import type { JoinRefusal } from "@/lib/video/join";

// What someone sees when a join link can't open the call right now. English only for now.

export const JOIN_METADATA = { title: "Join the call · Hourhand", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

const MESSAGES: Record<Exclude<JoinRefusal, "not_found">, { title: string; body: string }> = {
  not_video: { title: "This booking isn't on Hourhand video", body: "Check the booking for where you meet." },
  not_set_up: { title: "Video isn't available right now", body: "Hourhand video is not set up on this server. Please contact the host." },
  plan: { title: "Video isn't available for this booking", body: "The host's plan doesn't include Hourhand video right now. Please contact the host." },
  cancelled: { title: "This booking was cancelled or moved", body: "This link no longer opens a call. If it was moved, use the link from the latest confirmation." },
  not_confirmed: { title: "This booking isn't confirmed yet", body: "The call opens once the booking is confirmed." },
  too_early: { title: "The call hasn't opened yet", body: "The room opens 15 minutes before the start. Come back then with this same link." },
  ended: { title: "This call has ended", body: "The room closed 30 minutes after the booked end time." },
};

export function JoinRefused({ reason, opensAt, tz, back }: {
  reason: Exclude<JoinRefusal, "not_found">; opensAt?: Date; tz: string; back: { href: string; label: string };
}) {
  const msg = MESSAGES[reason];
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <h1 className="font-display text-xl text-text">{msg.title}</h1>
      <Card className="mt-4 max-w-md">
        <p className="text-text">{msg.body}</p>
        {reason === "too_early" && opensAt && (
          <p className="mt-2 text-text">Opens {formatDate(opensAt, tz, "en")} at <LocalTime date={opensAt} tz={tz} locale="en" /> ({zoneName(tz)}).</p>
        )}
      </Card>
      <Link href={back.href} className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{back.label}</Link>
    </main>
  );
}
