import { notFound, redirect } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";
import { Card } from "@/components/ui/Card";
import { VoicePay } from "@/components/VoicePay";
import { formatMoney } from "@/lib/billing/plans";
import { store } from "@/lib/data";
import { formatDate, zoneName } from "@/lib/format";
import { requestPaymentDeps } from "@/lib/payments/request-deps";

export const dynamic = "force-dynamic";

/**
 * The link a caller gets after the phone assistant held a paid time for them: pay within the hold and the booking is
 * confirmed. Anything other than a live hold goes to the booking's own page, which says what happened.
 */
export default async function VoicePayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const booking = await store.getBookingByManageToken(token);
  if (!booking) notFound();
  if (booking.status !== "pending_payment" || !booking.holdExpiresAt || booking.holdExpiresAt <= new Date()) redirect(`/b/${token}`);
  const deps = requestPaymentDeps();
  const [host, eventType, order] = await Promise.all([
    store.getUser(booking.hostId), store.getEventType(booking.hostId, booking.eventTypeId), deps?.pool.query("select provider_order_id, amount_minor, currency, collected_via from payments where booking_id = $1 and provider = 'razorpay' and status = 'pending'", [booking.id]),
  ]);
  const row = order?.rows[0];
  // The key the order was made on: Hourhand's when it collected for this host (B18), else the host's own.
  const auth = !deps || !row ? null : row.collected_via === "platform" ? await (deps.platformAuth?.() ?? null) : await deps.authFor(booking.hostId);
  if (!host || !eventType || !auth || !row) redirect(`/b/${token}`);
  const tz = booking.invitee.timezone;
  const amount = formatMoney(row.amount_minor, "INR");
  const realEmail = /\.invalid$/i.test(booking.invitee.email) ? "" : booking.invitee.email;
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <h1 className="font-display text-xl text-text">Pay to confirm your booking</h1>
      <Card className="mt-4 max-w-md">
        <dl className="grid gap-3">
          <div><dt className="text-sm text-text-muted">What</dt><dd className="text-text">{eventType.name} with {host.name}</dd></div>
          <div><dt className="text-sm text-text-muted">When</dt><dd className="text-text">{formatDate(booking.startAt, tz)}, <LocalTime date={booking.startAt} tz={tz} locale="en" /> {zoneName(tz)}</dd></div>
          <div><dt className="text-sm text-text-muted">Amount</dt><dd className="text-text">{amount}</dd></div>
        </dl>
      </Card>
      <p className="mt-4 max-w-md text-text-muted">
        This time is held for you until <LocalTime date={booking.holdExpiresAt} tz={tz} locale="en" />. If it isn&apos;t paid by then, it is released and nothing is charged.
      </p>
      <VoicePay
        token={token} label={`Pay ${amount}`} hostName={host.name} description={eventType.name}
        payment={{ keyId: auth.keyId, orderId: row.provider_order_id, amount: row.amount_minor, currency: row.currency, holdExpiresAt: booking.holdExpiresAt.toISOString() }}
        guest={{ name: booking.invitee.name, email: realEmail, phone: booking.invitee.phone ?? "" }}
      />
    </main>
  );
}
