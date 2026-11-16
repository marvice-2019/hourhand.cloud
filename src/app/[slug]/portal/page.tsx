import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MembershipSlot } from "@/components/portal/MembershipSlot";
import { PortalSignInForm } from "@/components/portal/PortalSignInForm";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { formatMoney } from "@/lib/billing/plans";
import { store, type User } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime, zoneName } from "@/lib/format";
import { resolveLocale, type Locale } from "@/lib/i18n/guest";
import { pt } from "@/lib/i18n/portal";
import { clientBookings, clientInvoices, clientPurchases, readSession } from "@/lib/portal/store";
import { PORTAL_COOKIE } from "@/lib/portal/tokens";
import { clientZone, packageBalance, rebookOptions, splitSessions, type SessionRow } from "@/lib/portal/view";
import { signOutAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ lang?: string; error?: string }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const host = await store.getUserBySlug((await params).slug);
  if (!host) return {};
  // A private page: keep it out of search engines.
  return { title: pt(resolveLocale((await searchParams).lang, host.locale), "metaTitle", { host: host.name }), robots: { index: false, follow: false } };
}

/** A client's portal with one host: sign in by emailed link, then sessions, packages, invoices and rebooking. */
export default async function PortalPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { lang, error } = await searchParams;
  const host = await store.getUserBySlug(slug);
  if (!host) notFound();
  const locale = resolveLocale(lang, host.locale);
  const session = authEnabled()
    ? await readSession(getPool(process.env.DATABASE_URL as string), (await cookies()).get(PORTAL_COOKIE)?.value, host.id, new Date())
    : null;

  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <LanguageSwitcher locale={locale} path={`/${host.slug}/portal`} />
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">{pt(locale, "signInHeading", { host: host.name })}</h1>
      {session ? <Portal host={host} email={session.email} locale={locale} /> : (
        <>
          <p className="mt-2 max-w-md text-text-muted">{pt(locale, "signInIntro")}</p>
          {error === "link" && <p role="alert" className="mt-4 max-w-md rounded-md bg-danger-bg p-3 text-sm text-danger">{pt(locale, "linkBad")}</p>}
          <Card className="mt-6 max-w-md">
            {authEnabled() ? <PortalSignInForm slug={host.slug} hostName={host.name} locale={locale} /> : <p className="text-text-muted">{pt(locale, "unavailable")}</p>}
          </Card>
          <p className="mt-4 max-w-md text-sm text-text-muted">{pt(locale, "phoneOnly")}</p>
        </>
      )}
    </main>
  );
}

async function Portal({ host, email, locale }: { host: User; email: string; locale: Locale }) {
  const db = getPool(process.env.DATABASE_URL as string);
  const now = new Date();
  // Every read is by this host AND this email; nothing else is in reach of the page.
  const [bookings, purchases, invoices] = await Promise.all([clientBookings(db, host.id, email), clientPurchases(db, host.id, email), clientInvoices(db, host.id, email)]);
  const tz = clientZone(bookings, host.timezone);
  const { upcoming, past } = splitSessions(bookings, now, tz);
  const rebook = rebookOptions(bookings);
  const q = `?lang=${locale}`;
  const when = (d: Date) => `${formatDate(d, tz, locale)}, ${formatTime(d, tz, host.timeFormat, locale)}`;
  const day = (r: SessionRow) => (r.relative ? `${pt(locale, r.relative)}, ${formatTime(r.booking.startAt, tz, host.timeFormat, locale)}` : when(r.booking.startAt));

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 text-sm text-text-muted">
        <span>{pt(locale, "signedInAs", { email })}</span>
        <form action={signOutAction}>
          <input type="hidden" name="slug" value={host.slug} />
          <input type="hidden" name="lang" value={locale} />
          <Button type="submit" variant="secondary" size="sm">{pt(locale, "signOut")}</Button>
        </form>
      </div>
      <p className="mt-1 text-sm text-text-muted">{pt(locale, "timesIn", { zone: zoneName(tz) })}</p>

      <section aria-labelledby="upcoming" className="mt-8 max-w-xl">
        <h2 id="upcoming" className="font-semibold text-text">{pt(locale, "upcoming")}</h2>
        {upcoming.length === 0 ? <p className="mt-2 text-text-muted">{pt(locale, "noUpcoming")}</p> : (
          <ul className="mt-2 grid gap-3">
            {upcoming.map((r) => (
              <li key={r.booking.id}>
                <Card>
                  <p className="font-semibold text-text">{r.booking.eventType.name}</p>
                  <p className="text-text">{day(r)} · {pt(locale, "minutes", { n: r.booking.eventType.durationMinutes })}</p>
                  {r.booking.joinUrl && <a href={r.booking.joinUrl} className="mt-1 inline-block font-semibold text-accent underline" rel="noopener noreferrer" target="_blank">{pt(locale, "joinCall")}</a>}
                  <p className="mt-2 text-sm text-text-muted">
                    {r.canChange
                      ? (r.changeUntil ? pt(locale, "changeUntil", { time: when(r.changeUntil) }) : null)
                      : pt(locale, "changesClosed", { host: host.name })}
                  </p>
                  <Link href={`/b/${r.booking.manageToken}${q}`} className={`mt-3 ${buttonClasses({ variant: r.canChange ? "primary" : "secondary", size: "sm" })}`}>
                    {pt(locale, r.canChange ? "change" : "details")}
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Memberships land in another change; this slot renders nothing until then. */}
      <MembershipSlot hostId={host.id} email={email} locale={locale} />

      {purchases.length > 0 && (
        <section aria-labelledby="packages" className="mt-8 max-w-xl">
          <h2 id="packages" className="font-semibold text-text">{pt(locale, "packages")}</h2>
          <ul className="mt-2 grid gap-3">
            {purchases.map((p) => {
              const bal = packageBalance(p, now);
              return (
                <li key={p.id}>
                  <Card>
                    <p className="font-semibold text-text">{p.name}</p>
                    <p className="text-lg font-semibold text-text">{pt(locale, "leftOf", { left: bal.left, n: p.sessions })}</p>
                    {p.expiresAt && <p className={`text-sm ${bal.expired ? "text-danger" : "text-text-muted"}`}>{pt(locale, bal.expired ? "endedOn" : "bookBy", { date: formatDate(p.expiresAt, tz, locale) })}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {bal.canBook && <Link href={`/p/${p.token}`} className={buttonClasses({ variant: "primary", size: "sm" })}>{pt(locale, "usePackage")}</Link>}
                      {p.onSale && <Link href={`/pkg/${p.packageId}`} className={buttonClasses({ variant: bal.canBook ? "secondary" : "primary", size: "sm" })}>{pt(locale, "topUp")}</Link>}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {rebook.length > 0 && (
        <section aria-labelledby="rebook" className="mt-8 max-w-xl">
          <h2 id="rebook" className="font-semibold text-text">{pt(locale, "bookAgain")}</h2>
          <p className="text-sm text-text-muted">{pt(locale, "bookAgainIntro")}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {rebook.map((e) => (
              <li key={e.slug}>
                <Link href={`/${host.slug}/${e.slug}?${new URLSearchParams({ lang: locale, email })}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                  {e.name} · {pt(locale, "minutes", { n: e.durationMinutes })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="past" className="mt-8 max-w-xl">
        <h2 id="past" className="font-semibold text-text">{pt(locale, "past")}</h2>
        {past.length === 0 ? <p className="mt-2 text-text-muted">{pt(locale, "noPast")}</p> : (
          <ul className="mt-2 grid gap-2">
            {past.map((r) => (
              <li key={r.booking.id} className={r.booking.status === "cancelled" ? "text-text-muted" : "text-text"}>
                <span className={r.booking.status === "cancelled" ? "line-through" : undefined}>{r.booking.eventType.name}, {when(r.booking.startAt)}</span>
                {r.booking.status === "cancelled" && <> · {pt(locale, "cancelled")}</>}
                {r.booking.noShow && <> · {pt(locale, "noShow")}</>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="invoices" className="mt-8 max-w-xl">
        <h2 id="invoices" className="font-semibold text-text">{pt(locale, "invoices")}</h2>
        {invoices.length === 0 ? <p className="mt-2 text-text-muted">{pt(locale, "noInvoices")}</p> : (
          <ul className="mt-2 grid gap-2">
            {invoices.map((v) => (
              <li key={v.id} className="text-text">
                {pt(locale, v.kind === "credit_note" ? "creditNote" : "invoice")} {v.number} · {formatDate(v.issuedAt, tz, locale)} · {formatMoney(v.totalMinor, "INR")}
                {" · "}<Link href={`/invoice/${v.token}`} className="font-semibold text-accent underline">{pt(locale, "viewInvoice")}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
