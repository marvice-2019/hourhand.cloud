import Link from "next/link";
import { isUnpaidRelease } from "@/lib/booking-reasons";
import { upcomingFirst } from "@/lib/booking";
import { store } from "@/lib/data";
import { zoneName } from "@/lib/format";
import { requireHost } from "@/lib/auth/session";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const user = await requireHost();
  const { t, date, time } = await getHostI18n();
  // Holds that lapsed unpaid were never bookings the host had; leave them out.
  const all = (await store.listBookings(user.id)).filter((b) => !(b.status === "cancelled" && isUnpaidRelease(b.cancelReason)));
  const { bookings, now } = upcomingFirst(all);
  const tz = user.timezone;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("bookings.title")}</h1>
      <p className="mt-2 text-text-muted">{t("bookings.intro", { zone: zoneName(tz) })}</p>
      {bookings.length === 0 ? (
        <p className="mt-6 text-text-muted">{t("bookings.empty")}</p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {bookings.map((b) => {
            const cancelled = b.status === "cancelled";
            const pending = b.status === "pending_payment";
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-2">
                <Link href={`/dashboard/bookings/${b.id}`} className={`inline-flex min-h-11 items-center font-semibold text-accent underline ${cancelled ? "line-through" : ""}`}>
                  {b.invitee.name}
                </Link>
                <span className="text-text">{t("bookings.dateTime", { date: date(b.startAt, tz), time: time(b.startAt, tz) })}</span>
                <span className={`rounded-md px-2 py-0.5 text-sm ${cancelled ? "bg-danger-bg text-danger" : pending ? "bg-warning-bg text-warning" : "bg-success-bg text-success"}`}>
                  {t(cancelled ? "bookings.statusCancelled" : pending ? "bookings.statusAwaitingPayment" : b.endAt.getTime() < now ? "bookings.statusDone" : "bookings.statusConfirmed")}
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
