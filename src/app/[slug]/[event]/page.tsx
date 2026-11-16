import { BookingFooter } from "@/components/BookingFooter";
import Link from "next/link";
import { EmbedResize } from "@/components/EmbedResize";
import { notFound } from "next/navigation";
import { BookingFlow } from "@/components/BookingFlow";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { resolveLocale, t } from "@/lib/i18n/guest";
import { formatAmount } from "@/lib/money";
import { guestDurations, lengthsLabel, priceRange } from "@/lib/durations";
import { authEnabled } from "@/lib/auth/auth";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { packagesForEventType } from "@/lib/packages/packages";
import { hostPlan } from "@/lib/billing/account";
import { whatsappOffered } from "@/lib/whatsapp-offer";
import { smsOffered } from "@/lib/sms/offer";
import { razorpayStatus } from "@/lib/payments/host-razorpay";

export default async function PublicEventPage({ params, searchParams }: { params: Promise<{ slug: string; event: string }>; searchParams: Promise<{ at?: string; lang?: string; name?: string; email?: string }> }) {
  const { slug, event } = await params;
  const { at, lang, name: prefillName, email: prefillEmail } = await searchParams;
  // ?name= and ?email= fill the form in, e.g. from a host's own site or CRM; the guest can still change them.
  const prefill = { name: typeof prefillName === "string" ? prefillName.slice(0, 100) : "", email: typeof prefillEmail === "string" ? prefillEmail.slice(0, 254) : "" };
  const found = await store.getPublicEventType(slug, event);
  if (!found) notFound();
  const { host, eventType } = found;
  const locale = resolveLocale(lang, host.locale);
  const langQuery = typeof lang === "string" && lang === locale ? `?lang=${locale}` : "";
  const questions = (await store.listCustomQuestions(host.id, eventType.id))
    .sort((a, b) => a.position - b.position)
    .map(({ id, label, kind, required }) => ({ id, label, kind, required }));
  // Packages need Postgres, a paid plan and the host's Razorpay; offered only when a buyer could actually pay.
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const canSell = pool ? (await hostPlan(pool, host.id)) !== "free" && (await razorpayStatus(pool, host.id)) !== null : false;
  const packages = pool && canSell ? await packagesForEventType(pool, host.id, eventType.id) : [];
  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
      <LanguageSwitcher locale={locale} path={`/${host.slug}/${eventType.slug}`} params={{ at: typeof at === "string" ? at : undefined }} />
      <Link href={`/${host.slug}${langQuery}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{host.name}</Link>
      <h1 className="font-display text-xl text-text">{eventType.name}</h1>
      <p className="mt-2 text-text-muted">{t(locale, "minutes", { n: lengthsLabel(eventType) })}{eventType.priceMinor !== null && ` · ${priceRange(eventType, (m) => formatAmount(m, eventType.currency))}`}</p>
      {eventType.description && <p className="mt-2 text-text">{eventType.description}</p>}
      {eventType.priceMinor === null && eventType.depositMinor !== null && (
        <p className="mt-2 max-w-xl rounded-md bg-surface p-3 text-sm text-text">
          {t(locale, "depositNote", { amount: formatAmount(eventType.depositMinor, eventType.currency), host: host.name })}
        </p>
      )}
      {eventType.cancelPolicy && (
        <div className="mt-3 max-w-xl text-sm">
          <p className="font-semibold text-text">{t(locale, "cancelPolicy")}</p>
          <p className="whitespace-pre-line text-text-muted">{eventType.cancelPolicy}</p>
        </div>
      )}
      {packages.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-6">
          {packages.map((p) => (
            <li key={p.id}>
              <Link href={`/pkg/${p.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">
                {t(locale, "packageOffer", { n: p.sessions, price: formatAmount(p.priceMinor, p.currency) })}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <BookingFlow
        slug={host.slug} event={eventType.slug} host={{ name: host.name, timezone: host.timezone }} durations={guestDurations(eventType, (m) => formatAmount(m, eventType.currency))} maxWeeks={eventType.priceMinor === null ? eventType.maxRepeats : 1} initialAt={typeof at === "string" ? at : undefined} bookingWindowDays={eventType.bookingWindowDays} questions={questions} waitlist={pool !== null} locale={locale} langQuery={langQuery} prefill={prefill} whatsapp={await whatsappOffered(host.id)} sms={await smsOffered(host.id)}
        paid={eventType.priceMinor !== null ? { price: formatAmount(eventType.priceMinor, eventType.currency), hostName: host.name, eventName: eventType.name }
          : eventType.depositMinor !== null ? { price: formatAmount(eventType.depositMinor, eventType.currency), hostName: host.name, eventName: eventType.name, deposit: true } : null}
      />
      <BookingFooter hostId={host.id} locale={locale} />
    </main>
  );
}
