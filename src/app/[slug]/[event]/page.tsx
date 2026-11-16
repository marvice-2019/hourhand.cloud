import type { Metadata } from "next";
import { BookingFooter } from "@/components/BookingFooter";
import Link from "next/link";
import { EmbedResize } from "@/components/EmbedResize";
import { notFound } from "next/navigation";
import { BookingFlow } from "@/components/BookingFlow";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { resolveLocale, t } from "@/lib/i18n/guest";
import { formatAmount } from "@/lib/money";
import { durationChoices, guestDurations, lengthsLabel, priceRange } from "@/lib/durations";
import { authEnabled } from "@/lib/auth/auth";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { packagesForEventType } from "@/lib/packages/packages";
import { hostPlan } from "@/lib/billing/account";
import { whatsappOffered } from "@/lib/whatsapp-offer";
import { smsOffered } from "@/lib/sms/offer";
import { razorpayStatus } from "@/lib/payments/host-razorpay";
import { countPageView } from "@/lib/analytics/page-view";
import { pagePricing } from "@/lib/offers/offers";
import { discountText } from "@/lib/offers/labels";
import { CampaignBanner } from "@/components/CampaignBanner";
import { rebookPrefill } from "@/lib/follow-ups/follow-ups";
import { linkKey } from "@/lib/follow-ups/tokens";

export default async function PublicEventPage({ params, searchParams }: { params: Promise<{ slug: string; event: string }>; searchParams: Promise<{ at?: string; lang?: string; name?: string; email?: string; rebook?: string } & Record<string, string | string[] | undefined>> }) {
  const { slug, event } = await params;
  const query = await searchParams;
  const { at, lang, name: prefillName, email: prefillEmail, rebook } = query;
  // ?name= and ?email= fill the form in, e.g. from a host's own site or CRM; the guest can still change them.
  let prefill = { name: typeof prefillName === "string" ? prefillName.slice(0, 100) : "", email: typeof prefillEmail === "string" ? prefillEmail.slice(0, 254) : "" };
  const found = await store.getPublicEventType(slug, event);
  if (!found) notFound();
  const { host, eventType } = found;
  const source = await countPageView(host.id, eventType.id, query);
  // ?rebook= is a follow-up email's signed link: the guest's details come from their earlier booking with this host.
  // A link that doesn't check out just leaves the form as it is.
  if (typeof rebook === "string" && authEnabled()) {
    let key: Buffer | null = null;
    try { key = linkKey(); } catch { /* no signing key on this server */ }
    const fromBooking = key ? await rebookPrefill(getPool(process.env.DATABASE_URL as string), key, rebook, host.id, new Date()) : null;
    if (fromBooking) prefill = fromBooking;
  }
  const locale = resolveLocale(lang, host.locale);
  const langQuery = typeof lang === "string" && lang === locale ? `?lang=${locale}` : "";
  const questions = (await store.listCustomQuestions(host.id, eventType.id))
    .sort((a, b) => a.position - b.position)
    .map(({ id, label, kind, required }) => ({ id, label, kind, required }));
  // Packages need Postgres, a paid plan and the host's Razorpay; offered only when a buyer could actually pay.
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const plan = pool ? await hostPlan(pool, host.id) : "free";
  const canSell = pool ? plan !== "free" && (await razorpayStatus(pool, host.id)) !== null : false;
  const packages = pool && canSell ? await packagesForEventType(pool, host.id, eventType.id) : [];
  // Offers on the price (never a deposit): today's campaign, a sliding scale, a code box, the first-session line.
  // Prices saved before the currency was recorded are rupees. pagePricing checks the plan; Razorpay or Stripe is the
  // booking route's business, so a Stripe host's offers show here too.
  const currency = eventType.currency ?? "INR";
  const money = (m: number) => formatAmount(m, currency);
  const pricing = pool && eventType.priceMinor !== null
    ? await pagePricing(pool, host.id, plan, { kind: "event_type", id: eventType.id, listMinor: eventType.priceMinor, currency }, new Date())
    : null;
  // Several lengths at different prices: the header shows the range, and each length carries today's campaign price
  // for it, so what the guest sees after picking a length is what they're charged.
  const lengthPrices = new Set(durationChoices(eventType).map((c) => c.priceMinor)).size > 1;
  const priceText = eventType.priceMinor === null ? null
    : pricing?.sliding ? `${money(pricing.sliding.minMinor)}–${money(pricing.sliding.maxMinor)}`
    : lengthPrices ? priceRange(eventType, money)
    : money(eventType.priceMinor);
  const choices = guestDurations(eventType, money);
  const durations = choices && pool && eventType.priceMinor !== null && !pricing?.sliding
    ? await Promise.all(choices.map(async (c) => ({
      ...c,
      campaignMinor: c.priceMinor === null ? null
        : (await pagePricing(pool, host.id, plan, { kind: "event_type", id: eventType.id, listMinor: c.priceMinor, currency }, new Date())).campaign?.chargeMinor ?? null,
    })))
    : choices;
  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
      <LanguageSwitcher locale={locale} path={`/${host.slug}/${eventType.slug}`} params={{ at: typeof at === "string" ? at : undefined }} />
      <Link href={`/${host.slug}${langQuery}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{host.name}</Link>
      <h1 className="font-display text-xl text-text">{eventType.name}</h1>
      {pricing?.campaign && <CampaignBanner name={pricing.campaign.name} banner={pricing.campaign.banner} />}
      <p className="mt-2 text-text-muted">
        {t(locale, "minutes", { n: lengthsLabel(eventType) })}
        {priceText && (pricing?.campaign && !lengthPrices
          ? <> · <s>{priceText}</s> <span className="font-semibold text-text">{t(locale, "offerWith", { price: money(pricing.campaign.chargeMinor), name: pricing.campaign.name })}</span></>
          : ` · ${priceText}`)}
      </p>
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
        slug={host.slug} event={eventType.slug} host={{ name: host.name, timezone: host.timezone }} durations={durations} maxWeeks={eventType.priceMinor === null ? eventType.maxRepeats : 1} initialAt={typeof at === "string" ? at : undefined} bookingWindowDays={eventType.bookingWindowDays} questions={questions} waitlist={pool !== null} locale={locale} langQuery={langQuery} prefill={prefill} whatsapp={await whatsappOffered(host.id)} sms={await smsOffered(host.id)} source={source}
        offers={pricing && eventType.priceMinor !== null ? {
          listMinor: eventType.priceMinor, currency, campaign: pricing.campaign && { name: pricing.campaign.name, chargeMinor: pricing.campaign.chargeMinor },
          sliding: pricing.sliding, coupons: pricing.coupons, firstSession: pricing.firstSession && discountText(pricing.firstSession),
        } : null}
        paid={eventType.priceMinor !== null ? { price: formatAmount(eventType.priceMinor, eventType.currency), hostName: host.name, eventName: eventType.name }
          : eventType.depositMinor !== null ? { price: formatAmount(eventType.depositMinor, eventType.currency), hostName: host.name, eventName: eventType.name, deposit: true } : null}
      />
      <BookingFooter hostId={host.id} locale={locale} />
    </main>
  );
}

/** The service's own title and line in link previews; the image is the host's card from ../opengraph-image.tsx. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string; event: string }> }): Promise<Metadata> {
  const { slug, event } = await params;
  const found = await store.getPublicEventType(slug, event);
  if (!found) return {};
  const { host, eventType } = found;
  const title = `${eventType.name} · ${host.name}`;
  const description = eventType.description ?? `Book ${eventType.name} with ${host.name}.`;
  const path = `/${host.slug}/${eventType.slug}`;
  // Setting openGraph here drops the image inherited from the host's segment, so it is named again.
  const images = [{ url: `/${host.slug}/opengraph-image`, width: 1200, height: 630, alt: `Book ${host.name}` }];
  return {
    title, description, alternates: { canonical: path },
    openGraph: { type: "website", siteName: "Hourhand", url: path, title, description, images },
    twitter: { card: "summary_large_image", title, description, images },
  };
}
