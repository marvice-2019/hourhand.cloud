import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { BOOKING_VIEWS, PAGE_LIMIT, bookingsQueryString, isFiltered, parseBookingsQuery, searchBookings, type BookingView } from "@/lib/bookings-search";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { zoneName } from "@/lib/format";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

const VIEW_KEYS: Record<BookingView, HostKey> = {
  all: "bookings.viewAll", upcoming: "bookings.viewUpcoming", past: "bookings.viewPast", cancelled: "bookings.viewCancelled", requests: "bookings.viewRequests",
};

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getHostContext();
  if (!ctx) redirect("/sign-in");
  const user = ctx.host;
  const { t, tNodes, date, time } = await getHostI18n();
  const query = parseBookingsQuery(await searchParams);
  const at = new Date();
  const tz = user.timezone;
  const [all, eventTypes] = await Promise.all([store.listBookings(user.id), store.listEventTypes(user.id)]);
  const { bookings: matching, requests, now } = searchBookings(all, query, tz, at);
  const bookings = matching.slice(0, PAGE_LIMIT);
  const names = new Map(eventTypes.map((e) => [e.id, e.name]));
  const filtered = isFiltered(query);
  // B12: downloads take the client list off Hourhand, so only the account's owner gets one, on a plan with downloads.
  const plan = authEnabled() ? await hostPlan(getPool(process.env.DATABASE_URL as string), user.id) : "free";
  const canDownload = !ctx.acting && LIMITS[plan].reportExport;
  const field = `mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;
  const queryString = bookingsQueryString(query);
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("bookings.title")}</h1>
      <p className="mt-2 text-text-muted">{t("bookings.intro", { zone: zoneName(tz) })}</p>
      {requests > 0 && (
        <p className="mt-4 rounded-md bg-warning-bg px-3 py-2 text-warning">
          {requests === 1 ? t("bookings.requestWaiting") : t("bookings.requestsWaiting", { n: requests })}{" "}
          {query.view === "requests"
            ? <Link href="/dashboard/bookings" className="font-semibold underline">{t("bookings.showAllBookings")}</Link>
            : <Link href="/dashboard/bookings?view=requests" className="font-semibold underline">{t("bookings.showRequests")}</Link>}
        </p>
      )}

      <form method="get" action="/dashboard/bookings" role="search" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="q" className="block text-sm font-semibold text-text">{t("bookings.searchLabel")}</label>
          <input id="q" name="q" type="search" maxLength={100} defaultValue={query.q} placeholder={t("bookings.searchPlaceholder")} className={`${field} w-64 max-w-full`} />
        </div>
        <div>
          <label htmlFor="view" className="block text-sm font-semibold text-text">{t("bookings.show")}</label>
          <select id="view" name="view" defaultValue={query.view} className={field}>
            {BOOKING_VIEWS.map((v) => <option key={v} value={v}>{t(VIEW_KEYS[v])}</option>)}
          </select>
        </div>
        {eventTypes.length > 1 && (
          <div>
            <label htmlFor="event" className="block text-sm font-semibold text-text">{t("bookings.eventType")}</label>
            <select id="event" name="event" defaultValue={query.eventTypeId ?? ""} className={field}>
              <option value="">{t("bookings.allEventTypes")}</option>
              {eventTypes.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="from" className="block text-sm font-semibold text-text">{t("bookings.from")}</label>
          <input id="from" name="from" type="date" defaultValue={query.from ?? ""} className={field} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm font-semibold text-text">{t("bookings.to")}</label>
          <input id="to" name="to" type="date" defaultValue={query.to ?? ""} className={field} />
        </div>
        <Button type="submit">{t("bookings.find")}</Button>
        {filtered && <Link href="/dashboard/bookings" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("bookings.clear")}</Link>}
      </form>

      {filtered && matching.length > 0 && (
        <p role="status" className="mt-3 text-sm text-text-muted">{matching.length === 1 ? t("bookings.matchOne") : t("bookings.matchCount", { n: matching.length })}</p>
      )}
      {matching.length > PAGE_LIMIT && (
        <p role="status" className="mt-3 text-sm text-text">{t("bookings.showingFirst", { shown: PAGE_LIMIT, n: matching.length })}</p>
      )}

      {matching.length === 0 ? (
        <p className="mt-6 text-text-muted">{filtered ? t("bookings.noMatch") : t("bookings.empty")}</p>
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
                {names.get(b.eventTypeId) && <span className="text-text-muted">{names.get(b.eventTypeId)}</span>}
                <span className={`rounded-md px-2 py-0.5 text-sm ${cancelled ? "bg-danger-bg text-danger" : pending ? "bg-warning-bg text-warning" : "bg-success-bg text-success"}`}>
                  {t(cancelled ? "bookings.statusCancelled" : b.status === "pending_approval" ? "bookings.statusAwaitingApproval" : b.status === "confirmed" && b.rescheduleRequestedAt && b.startAt.getTime() > now ? "bookings.statusAskedToMove" : pending ? "bookings.statusAwaitingPayment" : b.endAt.getTime() < now ? "bookings.statusDone" : "bookings.statusConfirmed")}
                </span>
                {b.invitee.noShowAt && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{t("bookings.noShow")}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {matching.length > 0 && !ctx.acting && (
        <p className="mt-6 text-sm text-text-muted">
          {canDownload ? (
            <>
              <a href={`/dashboard/bookings/export${queryString ? `?${queryString}` : ""}`} className="inline-flex min-h-11 items-center text-base font-semibold text-accent underline">{t("bookings.download")}</a>{" "}
              {t("bookings.downloadNote")}
            </>
          ) : tNodes("bookings.downloadPaid", { plans: <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("bookings.soloAndDuo")}</Link> })}
        </p>
      )}
    </div>
  );
}
