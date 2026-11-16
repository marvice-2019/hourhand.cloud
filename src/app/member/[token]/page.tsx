import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { BookingFlow } from "@/components/BookingFlow";
import { BookingFooter } from "@/components/BookingFooter";
import { MembershipCancel } from "@/components/MembershipCancel";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { formatMoney } from "@/lib/billing/plans";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime, zoneName } from "@/lib/format";
import { creditsLeft, isRenewing, memberEventTypes, memberSessions, membershipByToken } from "@/lib/memberships/memberships";
import { whatsappOffered } from "@/lib/whatsapp-offer";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  created: "Waiting for payment", authenticated: "Payment set up, first charge pending", active: "Active", pending: "Payment failed, retrying",
  halted: "On hold: payment failed", paused: "Paused", cancelled: "Ended", completed: "Ended", expired: "Ended",
};

/** The member's own page: status, sessions left, their bookings, booking the next one, and cancelling. */
export default async function MemberPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ event?: string }> }) {
  const { token } = await params;
  const { event } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const m = db ? await membershipByToken(db, token) : null;
  if (!m) notFound();
  const host = await store.getUser(m.hostId);
  if (!host) notFound();
  const now = new Date();
  const [left, eventTypes, sessions] = await Promise.all([creditsLeft(db!, m, now), memberEventTypes(db!, m.planId), memberSessions(db!, m.id)]);
  const tz = host.timezone;
  const until = m.paidThrough ? formatDate(m.paidThrough, tz) : null;
  const ended = ["cancelled", "completed", "expired"].includes(m.status);
  const waiting = m.charges === 0 && !ended && m.status !== "pending" && m.status !== "halted";
  const chosen = eventTypes.find((e) => e.slug === event) ?? eventTypes[0];
  const full = chosen ? await store.getEventType(host.id, chosen.id) : null;
  const questions = full ? (await store.listCustomQuestions(host.id, full.id)).sort((a, b) => a.position - b.position).map(({ id, label, kind, required }) => ({ id, label, kind, required })) : [];

  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">Your membership</h1>
      <Card className="mt-4 max-w-md">
        <dl className="grid gap-3">
          <div><dt className="text-sm text-text-muted">Plan</dt><dd className="text-text">{m.planName}: {m.sessions} a month, {formatMoney(m.priceMinor, "INR")}</dd></div>
          <div><dt className="text-sm text-text-muted">Status</dt><dd className={m.status === "pending" || m.status === "halted" ? "text-danger" : "text-text"}>
            {m.cancelAtPeriodEnd && !ended ? `Cancelled, ends ${until ?? "at the end of the month"}` : STATUS[m.status]}
          </dd></div>
          {m.charges > 0 && <div><dt className="text-sm text-text-muted">Sessions left</dt><dd className="text-lg font-semibold text-text">{left}</dd></div>}
          {until && !ended && <div><dt className="text-sm text-text-muted">{isRenewing(m) ? "Renews" : "Paid until"}</dt><dd className="text-text">{until}</dd></div>}
          <div><dt className="text-sm text-text-muted">For</dt><dd className="text-text">{m.guestName}, {m.guestEmail}</dd></div>
        </dl>
      </Card>

      {waiting && (
        <div className="mt-6 max-w-md" role="status">
          <p className="text-text">Waiting for Razorpay to confirm your first payment. This usually takes under a minute; your sessions appear here as soon as it does.</p>
          {m.status === "created" && m.shortUrl && <p className="mt-2 text-text-muted">Didn&apos;t finish? <a href={m.shortUrl} className="font-semibold text-accent underline">Set up the payment on Razorpay</a>.</p>}
          <AutoRefresh />
        </div>
      )}
      {(m.status === "pending" || m.status === "halted") && (
        <p className="mt-6 max-w-md text-text" role="alert">This month&apos;s payment hasn&apos;t gone through{m.status === "halted" ? " and Razorpay has stopped retrying" : "; Razorpay will retry"}. Sessions you have left can be booked for times before {until}.</p>
      )}

      {sessions.length > 0 && (
        <section aria-labelledby="booked" className="mt-8 max-w-md">
          <h2 id="booked" className="font-semibold text-text">Booked</h2>
          <ul className="mt-2 grid gap-2">
            {sessions.map((b) => (
              <li key={b.id} className={b.status === "cancelled" ? "text-text-muted line-through" : "text-text"}>
                {b.eventName}: {formatDate(b.startAt, b.timezone)}, {formatTime(b.startAt, b.timezone)} {zoneName(b.timezone)}
                {b.status === "confirmed" && <> · <Link href={`/b/${b.manageToken}`} className="font-semibold text-accent underline">Change</Link></>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {left > 0 && chosen && full && (
        <section aria-labelledby="book" className="mt-8">
          <h2 id="book" className="font-semibold text-text">Book a session</h2>
          {eventTypes.length > 1 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {eventTypes.map((e) => (
                <li key={e.id}><Link href={`/member/${token}?event=${encodeURIComponent(e.slug)}`} aria-current={e.id === chosen.id ? "page" : undefined}
                  className={`rounded-md border border-border px-3 py-1 text-sm ${e.id === chosen.id ? "bg-surface font-semibold text-text" : "text-text-muted"}`}>{e.name}</Link></li>
              ))}
            </ul>
          )}
          <BookingFlow
            key={full.id} slug={host.slug} event={full.slug} host={{ name: host.name, timezone: host.timezone }} bookingWindowDays={full.bookingWindowDays}
            questions={questions} packageToken={token} maxWeeks={Math.min(left, 12)} whatsapp={await whatsappOffered(host.id)}
          />
        </section>
      )}
      {m.charges > 0 && left === 0 && !ended && <p className="mt-8 max-w-md text-text">You&apos;ve booked every session you have. {isRenewing(m) && until ? `More are added when your membership renews on ${until}.` : ""}</p>}

      {!ended && !m.cancelAtPeriodEnd && (
        <section aria-labelledby="cancel" className="mt-10 max-w-md">
          <h2 id="cancel" className="sr-only">Cancel</h2>
          <MembershipCancel token={token} until={m.charges > 0 ? until : null} />
        </section>
      )}
      <BookingFooter hostId={host.id} />
    </main>
  );
}
