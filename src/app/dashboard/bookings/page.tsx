import Link from "next/link";
import { isUnpaidRelease } from "@/lib/booking-reasons";
import { upcomingFirst } from "@/lib/booking";
import { store } from "@/lib/data";
import { zoneName } from "@/lib/format";
import { requireHost } from "@/lib/auth/session";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const user = await requireHost();
  const { t, date, time } = await getHostI18n();
  const { show } = await searchParams;
  // Holds that lapsed unpaid were never bookings the host had; leave them out.
  const all = (await store.listBookings(user.id)).filter((b) => !(b.status === "cancelled" && isUnpaidRelease(b.cancelReason)));
  const at = new Date();
  // Booking requests (B9) still waiting on the host's answer.
  const isRequest = (b: (typeof all)[number]) => b.status === "pending_approval" && b.holdExpiresAt !== null && b.holdExpiresAt > at;
  const requests = all.filter(isRequest);
  const onlyRequests = show === "requests" && requests.length > 0;
  const { bookings, now } = upcomingFirst(onlyRequests ? requests : all.filter((b) => b.status !== "pending_approval" || isRequest(b)), at);
  const tz = user.timezone;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("bookings.title")}</h1>
      <p className="mt-2 text-text-muted">{t("bookings.intro", { zone: zoneName(tz) })}</p>
      {requests.length > 0 && (
        <p className="mt-4 rounded-md bg-warning-bg px-3 py-2 text-warning">
          {requests.length === 1 ? t("bookings.requestWaiting") : t("bookings.requestsWaiting", { n: requests.length })}{" "}
          {onlyRequests
            ? <Link href="/dashboard/bookings" className="font-semibold underline">{t("bookings.showAllBookings")}</Link>
            : <Link href="/dashboard/bookings?show=requests" className="font-semibold underline">{t("bookings.showRequests")}</Link>}
        </p>
      )}
      {bookings.length === 0 ? (
        <p className="mt-6 text-text-muted">{t("bookings.empty")}</p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {bookings.map((b) => {
            const cancelled = b.status === "cancelled";
            const pending = b.status === "pending_payment" || b.status === "pending_approval";
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-2">
                <Link href={`/dashboard/bookings/${b.id}`} className={`inline-flex min-h-11 items-center font-semibold text-accent underline ${cancelled ? "line-through" : ""}`}>
                  {b.invitee.name}
                </Link>
                <span className="text-text">{t("bookings.dateTime", { date: date(b.startAt, tz), time: time(b.startAt, tz) })}</span>
                <span className={`rounded-md px-2 py-0.5 text-sm ${cancelled ? "bg-danger-bg text-danger" : pending ? "bg-warning-bg text-warning" : "bg-success-bg text-success"}`}>
                  {t(cancelled ? "bookings.statusCancelled" : b.status === "pending_approval" ? "bookings.statusAwaitingApproval" : b.status === "confirmed" && b.rescheduleRequestedAt && b.startAt.getTime() > now ? "bookings.statusAskedToMove" : pending ? "bookings.statusAwaitingPayment" : b.endAt.getTime() < now ? "bookings.statusDone" : "bookings.statusConfirmed")}
                </span>
                {b.invitee.noShowAt && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{t("bookings.noShow")}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
