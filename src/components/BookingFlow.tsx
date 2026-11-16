"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { focusRing } from "@/components/ui/focus";
import { formatDate, formatTime, zoneName } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { t, tNodes, type GuestKey, type Locale } from "@/lib/i18n/guest";
import { offerLabel } from "@/lib/offers/labels";
import type { AppliedOffer } from "@/lib/offers/offers";
import { zoneCheck } from "@/lib/tz-confirm";
import { LocalTime } from "./LocalTime";
import { payWithRazorpay, type CheckoutPayment } from "./razorpay-checkout";
import { SlotPicker, useDeviceZone } from "./SlotPicker";
import { useTimeFormat } from "./useTimeFormat";
import { WaitlistForm } from "./WaitlistForm";
import { IntakeFields, answerErrorMessage, answersToSend, readAnswers } from "./intake/IntakeFields";
import type { IntakeQuestion, RawAnswers } from "@/lib/intake/conditions";
import { sendSlotClick } from "./analytics-beacon";
import type { SourceInput } from "@/lib/analytics/source";

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A question on the form: see src/lib/intake/conditions.ts. */
export type FlowQuestion = IntakeQuestion;

interface Props {
  slug: string;
  event: string;
  bookingWindowDays: number;
  questions: FlowQuestion[];
  /** For a priced event: the price as shown ("₹499") and the names Checkout shows the guest. */
  paid?: { price: string; hostName: string; eventName: string; deposit?: boolean; /** Minor units and currency, for the total of a weekly series. */ priceMinor?: number; currency?: string | null } | null;
  /** Booking through a single-use link: times and the booking go through the link, which is used up by the booking. */
  linkToken?: string;
  /** Open the picker on this suggested time's day. */
  initialAt?: string;
  /** Whose page this is, so the form can show the time on their clock too. */
  host: { name: string; timezone: string };
  /** The most weeks the guest can book this time for in one go; 1 = no repeat choice. */
  maxWeeks?: number;
  /** Booking with a session package (the buyer's token): no payment, one session used per booking. */
  packageToken?: string;
  /** The guest's language, and "?lang=xx" when they chose it (carried to the next page). */
  locale?: Locale;
  langQuery?: string;
  /** Starting values for the guest's name and email, from the link. */
  prefill?: { name: string; email: string };
  /** Offer the waitlist (needs Postgres; not for single-use links or packages). */
  waitlist?: boolean;
  /** Offer automatic WhatsApp updates to the phone the guest gives. */
  whatsapp?: boolean;
  /** Offer booking texts (SMS) to an Indian mobile the guest gives. */
  sms?: boolean;
  /** Offers on a priced event: the price after today's campaign, a sliding scale, whether a code box is shown, the first-session line. */
  offers?: FlowOffers | null;
  /** Where this visit came from (public booking pages only): sent with the slot beacon and the booking for the host's analytics. */
  source?: SourceInput;
  /**
   * Lengths to pick from (2 or more), shortest first: each with its price as shown (null = free), in minor units, and the
   * price after today's campaign for that length. Left out = one length.
   */
  durations?: { minutes: number; price: string | null; priceMinor?: number | null; campaignMinor?: number | null }[];
}

export interface FlowOffers {
  listMinor: number;
  /** The price's ISO currency; amounts are shown in it. */
  currency: string;
  /** The price after today's best campaign, and its name. */
  campaign: { name: string; chargeMinor: number } | null;
  sliding: { minMinor: number; suggestedMinor: number; maxMinor: number; note: string | null } | null;
  coupons: boolean;
  /** "20%" or "₹200" when the host gives new clients a first-session discount. */
  firstSession: string | null;
}

/** Public booking: pick a time, then fill in details. The picker stays mounted so "Pick another time" keeps the month and day. */
export function BookingFlow({ slug, event, bookingWindowDays, questions, paid = null, linkToken, initialAt, host, maxWeeks = 1, packageToken, waitlist = false, locale = "en", langQuery = "", prefill, whatsapp = false, sms = false, source, offers = null, durations }: Props) {
  const [picked, setPicked] = useState<{ slot: string; tz: string } | null>(null);
  // Several lengths: the guest picks one first; times, the price and the booking all follow it.
  const choosing = durations !== undefined && durations.length > 1;
  const [duration, setDuration] = useState<number | null>(null);
  const chosen = choosing ? durations.find((d) => d.minutes === duration) ?? null : null;
  const shownPaid = paid && chosen?.price ? { ...paid, price: chosen.price, priceMinor: chosen.priceMinor ?? paid.priceMinor } : paid;
  // Offers follow the chosen length: its list price, and today's campaign price for it (worked out on the server).
  const shownOffers = offers && chosen && chosen.priceMinor != null
    ? { ...offers, listMinor: chosen.priceMinor, campaign: offers.campaign && chosen.campaignMinor != null ? { ...offers.campaign, chargeMinor: chosen.campaignMinor } : offers.campaign }
    : offers;
  return (
    <>
      <div hidden={picked !== null}>
        {choosing && (
          <fieldset className="mt-6">
            <legend className="font-semibold text-text">{t(locale, "pickLength")}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {durations.map((d) => (
                <label key={d.minutes} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 ${duration === d.minutes ? "border-accent bg-surface font-semibold" : "border-border-input"} text-text`}>
                  <input type="radio" name="duration" value={d.minutes} checked={duration === d.minutes} onChange={() => setDuration(d.minutes)} className={`size-5 accent-accent ${focusRing}`} />
                  <span>{t(locale, "minutes", { n: d.minutes })}{d.price && ` · ${d.price}`}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {(!choosing || duration !== null) && (
          <SlotPicker slug={slug} event={event} linkToken={linkToken} initialAt={initialAt} bookingWindowDays={bookingWindowDays} duration={choosing ? duration ?? undefined : undefined} locale={locale} onPick={(slot, tz) => { if (source) sendSlotClick(slug, event, source); setPicked({ slot, tz }); }} />
        )}
        {waitlist && <WaitlistForm slug={slug} event={event} hostName={host.name} locale={locale} />}
      </div>
      {picked && (
        <DetailsForm
          slug={slug} event={event} linkToken={linkToken} tz={picked.tz} slot={picked.slot} questions={questions} paid={packageToken ? null : shownPaid} duration={choosing ? duration ?? undefined : undefined} host={host} maxWeeks={maxWeeks} packageToken={packageToken} locale={locale} langQuery={langQuery} prefill={prefill} whatsapp={whatsapp} sms={sms} source={source}
          offers={packageToken || paid?.deposit ? null : shownOffers}
          onPick={(slot) => setPicked({ slot, tz: picked.tz })} onBack={() => setPicked(null)}
        />
      )}
    </>
  );
}

interface FormProps {
  slug: string; event: string; linkToken?: string; tz: string; slot: string; questions: FlowQuestion[]; paid: Props["paid"]; host: Props["host"]; maxWeeks: number; packageToken?: string; locale: Locale; langQuery: string; prefill?: { name: string; email: string }; whatsapp: boolean; sms: boolean; duration?: number;
  offers: FlowOffers | null;
  source?: SourceInput;
  onPick: (slot: string) => void; onBack: () => void;
}

function DetailsForm({ slug, event, linkToken, tz, slot, questions, paid, host, maxWeeks, packageToken, locale, langQuery, prefill, whatsapp, sms, offers, source, duration, onPick, onBack }: FormProps) {
  const router = useRouter();
  // Offers: the code the guest applied and what the server quoted for it, and a sliding-scale amount in rupees.
  const [code, setCode] = useState("");
  const [quote, setQuote] = useState<{ code: string; offer: AppliedOffer | null; chargeMinor: number; couponNotUsed: boolean } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [payRupees, setPayRupees] = useState(() => (offers?.sliding ? String(offers.sliding.suggestedMinor / 100) : ""));
  const payMinor = offers?.sliding ? Math.round(Number(payRupees) * 100) : null;
  const money = (m: number) => formatAmount(m, offers?.currency ?? "INR");
  /** The price the button shows; the server works out the real one when the order is made. */
  const unitMinor = paid && offers
    ? (offers.sliding ? (Number.isFinite(payMinor) && payMinor! > 0 ? payMinor! : offers.sliding.suggestedMinor) : quote?.chargeMinor ?? offers.campaign?.chargeMinor ?? offers.listMinor)
    : paid?.priceMinor ?? null;
  const shownPrice = paid && offers && unitMinor !== null ? money(unitMinor) : paid?.price ?? "";

  async function applyCode() {
    const c = code.trim();
    if (!c) return;
    setApplying(true); setCodeError(null);
    try {
      const res = await fetch("/api/offers/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, event, couponCode: c, ...(duration ? { duration } : {}) }) });
      const body = await res.json();
      if (res.ok) setQuote({ code: c, offer: body.offer ?? null, chargeMinor: body.chargeMinor, couponNotUsed: body.couponNotUsed === true });
      else { setQuote(null); setCodeError(t(locale, res.status === 429 ? "rateLimited" : "offerCodeInvalid")); }
    } catch {
      setCodeError(t(locale, "offline"));
    }
    setApplying(false);
  }
  // A new key starts a fresh attempt; it changes only after an attempt is over (payment couldn't start, or the hold ran out).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const freshAttempt = () => setIdempotencyKey(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [taken, setTaken] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [limited, setLimited] = useState(false);
  const [linkGone, setLinkGone] = useState<string | null>(null);
  // Paid events: the order the server made, kept so a guest who closes Checkout can reopen it while the hold lasts.
  const [held, setHeld] = useState<{ bookingId: string; manageToken: string; payment: CheckoutPayment & { holdExpiresAt: string }; prefill: { name: string; email: string; contact?: string } } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [checkoutFailed, setCheckoutFailed] = useState(false);
  const [notPaid, setNotPaid] = useState(false);
  const [expired, setExpired] = useState(false);

  // Once the hold runs out the Pay button goes: paying after that would only be refunded.
  useEffect(() => {
    if (!held) return;
    const left = new Date(held.payment.holdExpiresAt).getTime() - Date.now();
    const t = setTimeout(() => { setHeld(null); setExpired(true); freshAttempt(); }, Math.max(0, left));
    return () => clearTimeout(t);
  }, [held]);

  /** Opens Checkout; after a payment the server checks it with Razorpay. The booked page shows the result either way. */
  async function pay(h: NonNullable<typeof held>) {
    setCheckoutFailed(false); setNotPaid(false);
    let result;
    try {
      result = await payWithRazorpay(h.payment, { name: paid?.hostName ?? "", description: paid?.deposit ? t(locale, "depositDescription", { event: paid.eventName }) : paid?.eventName ?? "", prefill: h.prefill });
    } catch {
      setHeld(h);
      setCheckoutFailed(true);
      return;
    }
    if (!result) { setHeld(h); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/bookings/pay", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ manageToken: h.manageToken, paymentId: result.razorpay_payment_id, signature: result.razorpay_signature }),
      });
      // Razorpay says the payment didn't complete: stay here with the hold and let the guest try again.
      if (res.status === 400 && (await res.json().catch(() => ({}))).error === "not_paid") {
        setBusy(false); setNotPaid(true); setHeld(h);
        return;
      }
    } catch {
      // The reconciler confirms a real payment within a minute even if this call never arrives.
    }
    router.push(`/${slug}/${event}/booked/${h.bookingId}${langQuery}`);
  }
  const start = new Date(slot);
  const device = useDeviceZone();
  const cycle = useTimeFormat();
  const zone = zoneCheck(start, tz, device, host, cycle);
  const [zoneConfirmed, setZoneConfirmed] = useState(false);
  const [zoneError, setZoneError] = useState(false);
  const [weeks, setWeeks] = useState(1);
  const [weeksTaken, setWeeksTaken] = useState<string[] | null>(null);
  const [packageRefused, setPackageRefused] = useState<string | null>(null);
  // A priced weekly series is paid in one go: the button shows the per-session price (after any offer) for every week.
  const seriesPrice = paid && !paid.deposit && weeks > 1 && unitMinor ? formatAmount(unitMinor * weeks, offers?.currency ?? paid.currency) : shownPrice;
  const [showGuests, setShowGuests] = useState(false);
  // The intake answers so far, so a conditional question appears as soon as the earlier answer matches.
  const [intake, setIntake] = useState<RawAnswers>({});

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (zone.confirm && !zoneConfirmed) { setZoneError(true); document.getElementById("zone-confirm")?.focus(); return; }
    const data = new FormData(e.currentTarget);
    const current = readAnswers(e.currentTarget, questions);
    const answers = answersToSend(questions, current);
    const guests = String(data.get("guests") ?? "").split(/[\s,;]+/).filter(Boolean);
    setBusy(true); setFailed(false); setLimited(false); setExpired(false); setWeeksTaken(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(linkToken ? { linkToken } : { slug, event }), start: slot, name: data.get("name"), email: data.get("email"), phone: data.get("phone") || undefined, timezone: tz, answers, idempotencyKey, ...(weeks > 1 ? { weeks } : {}), ...(duration ? { duration } : {}), ...(packageToken ? { packageToken } : {}), ...(guests.length ? { guests } : {}), ...(data.get("whatsappOptIn") ? { whatsappOptIn: true } : {}), ...(data.get("smsOptIn") ? { smsOptIn: true } : {}), ...(source ? { src: source } : {}), locale, ...(offers && code.trim() ? { couponCode: code.trim() } : {}), ...(offers?.sliding && payMinor ? { payMinor } : {}) }),
      });
      const body = await res.json();
      if ((res.status === 201 || res.status === 200) && body.payment?.provider === "stripe" && typeof body.payment.url === "string") {
        // Stripe Checkout on the host's account. It can't run inside a frame, so an embedded booking page opens it in a new tab
        // and shows the held booking here; Stripe brings the guest back to the booked page, which checks the payment.
        if (window.top !== window.self) {
          window.open(body.payment.url, "_blank", "noopener");
          router.push(`/${slug}/${event}/booked/${body.bookingId}${langQuery}`);
        } else window.location.assign(body.payment.url);
        return;
      }
      if ((res.status === 201 || res.status === 200) && body.payment) {
        setBusy(false);
        const prefill = { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? ""), ...(data.get("phone") ? { contact: String(data.get("phone")) } : {}) };
        await pay({ bookingId: body.bookingId, manageToken: body.manageToken, payment: body.payment, prefill });
        return;
      }
      if (res.status === 201 || res.status === 200) {
        router.push(`/${slug}/${event}/booked/${body.bookingId}${langQuery}`);
        return;
      }
      if (typeof body.error === "string" && body.error.startsWith("link_")) setLinkGone(body.error);
      else if (typeof body.error === "string" && body.error.startsWith("package_")) setPackageRefused(body.error);
      else if (res.status === 409 && body.error === "payments_unavailable") setUnavailable(true);
      else if (res.status === 409 && body.error === "weeks_unavailable") setWeeksTaken(body.unavailable ?? []);
      else if ((res.status === 409 && body.error === "attempt_expired") || res.status === 502) { freshAttempt(); setFailed(true); }
      else if (res.status === 409) { setTaken(body.nextSlots ?? []); setErrors({}); }
      else if (res.status === 400) {
        // Server messages are English; show ours for the fields it names.
        const own: Record<string, GuestKey> = { name: "errName", email: "errEmail", phone: "errPhone", smsOptIn: "errSmsPhone", timezone: "errTimezone", guests: "errGuests", couponCode: "offerCodeInvalid" };
        const fields = (body.fields ?? {}) as Record<string, string>;
        const byId = new Map(questions.map((q) => [q.id, q]));
        const answerError = (k: string) => {
          const q = byId.get(k.slice("answers.".length));
          return q ? answerErrorMessage(locale, q, current[q.id]) : t(locale, "errAnswer");
        };
        const range = offers?.sliding ? { min: money(offers.sliding.minMinor), max: money(offers.sliding.maxMinor) } : { min: "", max: "" };
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === "payMinor" ? t(locale, "errPay", range) : own[k] ? t(locale, own[k]) : k.startsWith("answers.") ? answerError(k) : v])));
        if (fields.couponCode) { setQuote(null); setCodeError(t(locale, "offerCodeInvalid")); }
      }
      else if (res.status === 429) setLimited(true);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} onChange={(e) => { if (questions.length > 0) setIntake(readAnswers(e.currentTarget, questions)); }} noValidate className="mt-6 grid max-w-md gap-4">
      <div>
        <p className="font-semibold text-text">{formatDate(start, tz, locale)}, <LocalTime date={start} tz={tz} locale={locale} /> {zoneName(tz)}</p>
        {zone.hostLine && <p className="text-sm text-text-muted">{t(locale, "thatsHost", { time: formatTime(start, host.timezone, cycle, locale), zone: zoneName(host.timezone), name: host.name.split(/\s+/)[0] || host.name })}</p>}
        <button type="button" onClick={onBack} className={`min-h-11 text-sm font-semibold text-accent underline ${focusRing}`}>{t(locale, "pickAnother")}</button>
      </div>
      {zone.confirm && (
        <div className={`grid gap-2 rounded-md p-4 ${zoneError ? "bg-danger-bg" : "bg-warning-bg"}`}>
          <p className="text-text">
            {t(locale, "zoneMismatch", { zone: zoneName(tz), device: zoneName(device as string) })}
          </p>
          <label className="flex min-h-11 items-start gap-3 text-text">
            <input
              id="zone-confirm" type="checkbox" checked={zoneConfirmed} aria-invalid={zoneError || undefined} aria-describedby={zoneError ? "zone-confirm-error" : undefined}
              onChange={(e) => { setZoneConfirmed(e.target.checked); setZoneError(false); }}
              className={`mt-1 h-5 w-5 accent-accent ${focusRing}`}
            />
            <span>{t(locale, "zoneConfirm", { zone: zoneName(tz) })}</span>
          </label>
          {zoneError && <p id="zone-confirm-error" className="text-sm text-danger" role="alert">{t(locale, "zoneError")}</p>}
        </div>
      )}
      {taken && (
        <div className="rounded-md bg-danger-bg p-4" role="alert">
          <p className="text-danger">{t(locale, "justTaken")}</p>
          <ul className="mt-2 grid gap-2">
            {taken.map((s) => (
              <li key={s}>
                <Button variant="secondary" className="w-full" onClick={() => { setTaken(null); onPick(s); }}>
                  {formatDate(new Date(s), tz, locale)}, <LocalTime date={s} tz={tz} locale={locale} /> {zoneName(tz)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {maxWeeks > 1 && (
        <div>
          <Label htmlFor="weeks">{t(locale, "repeat")}</Label>
          <select
            id="weeks" value={weeks} onChange={(e) => { setWeeks(Number(e.target.value)); setWeeksTaken(null); }}
            className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}
          >
            <option value={1}>{t(locale, "justOnce")}</option>
            {Array.from({ length: maxWeeks - 1 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{t(locale, "everyWeek", { n })}</option>)}
          </select>
        </div>
      )}
      {weeksTaken && (
        <div className="rounded-md bg-danger-bg p-4" role="alert">
          <p className="text-danger">{t(locale, weeksTaken.length === 1 ? "weekTakenOne" : "weekTakenMany")}</p>
          <ul className="mt-2 list-disc pl-5 text-text">
            {weeksTaken.map((s) => <li key={s}>{formatDate(new Date(s), tz, locale)}</li>)}
          </ul>
          <p className="mt-2 text-text">{t(locale, "fewerWeeks")}</p>
        </div>
      )}
      <div><Label htmlFor="name">{t(locale, "yourName")}</Label><Input id="name" name="name" autoComplete="name" required maxLength={100} defaultValue={prefill?.name} error={errors.name} /></div>
      <div><Label htmlFor="email">{t(locale, "email")}</Label><Input id="email" name="email" type="email" autoComplete="email" required defaultValue={prefill?.email} error={errors.email} /></div>
      <div><Label htmlFor="phone">{t(locale, sms && !whatsapp ? "phoneOptionalSms" : "phoneOptional")}</Label><Input id="phone" name="phone" type="tel" autoComplete="tel" error={errors.phone} /></div>
      {whatsapp && (
        <label className="flex items-start gap-2 text-text">
          <input type="checkbox" name="whatsappOptIn" value="1" className="mt-1 size-5 accent-accent" />
          <span>{t(locale, "whatsappOptIn")}</span>
        </label>
      )}
      {sms && (
        <div>
          <label className="flex items-start gap-2 text-text">
            <input type="checkbox" name="smsOptIn" value="1" className="mt-1 size-5 accent-accent" aria-describedby={errors.smsOptIn ? "sms-error" : undefined} />
            <span>{t(locale, "smsOptIn")}</span>
          </label>
          {errors.smsOptIn && <p id="sms-error" className="mt-1 text-sm text-danger" role="alert">{errors.smsOptIn}</p>}
        </div>
      )}
      {showGuests || errors.guests ? (
        <div>
          <Label htmlFor="guests">{t(locale, "guestsLabel")}</Label>
          <Input id="guests" name="guests" type="text" inputMode="email" autoComplete="off" error={errors.guests} aria-describedby="guests-hint" />
          <p id="guests-hint" className="mt-1 text-sm text-text-muted">{t(locale, "guestsHint")}</p>
        </div>
      ) : (
        <button type="button" onClick={() => setShowGuests(true)} className={`min-h-11 justify-self-start text-sm font-semibold text-accent underline ${focusRing}`}>{t(locale, "addGuests")}</button>
      )}
      <IntakeFields questions={questions} answers={intake} errors={errors} locale={locale} hostName={host.name} />
      {paid && offers?.sliding && (
        <div>
          <Label htmlFor="payMinor">{t(locale, "slidingLabel", { min: money(offers.sliding.minMinor), max: money(offers.sliding.maxMinor) })}</Label>
          {offers.sliding.note && <p id="pay-note" className="mt-1 whitespace-pre-line text-sm text-text-muted">{offers.sliding.note}</p>}
          <Input
            id="payMinor" name="payMinor" inputMode="decimal" value={payRupees} onChange={(e) => setPayRupees(e.target.value)} error={errors.payMinor}
            aria-describedby={offers.sliding.note ? "pay-note" : undefined} className="max-w-40"
          />
          <p className="mt-1 text-sm text-text-muted">{t(locale, "slidingSuggested", { price: money(offers.sliding.suggestedMinor) })}</p>
        </div>
      )}
      {paid && offers && !offers.sliding && offers.firstSession && <p className="text-sm text-text-muted">{t(locale, "offerFirstSession", { amount: offers.firstSession })}</p>}
      {paid && offers && !offers.sliding && offers.coupons && (
        <div>
          <Label htmlFor="couponCode">{t(locale, "offerCodeLabel")}</Label>
          <div className="mt-1 flex gap-2">
            <Input
              id="couponCode" name="couponCode" autoComplete="off" autoCapitalize="characters" maxLength={32} value={code}
              onChange={(e) => { setCode(e.target.value); setCodeError(null); if (quote && e.target.value.trim() !== quote.code) setQuote(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void applyCode(); } }}
              aria-invalid={codeError ? true : undefined} aria-describedby={codeError ? "couponCode-error" : undefined} className="mt-0"
            />
            <Button type="button" variant="secondary" loading={applying} onClick={() => void applyCode()}>{t(locale, "offerApply")}</Button>
          </div>
          {codeError && <p id="couponCode-error" className="mt-1 text-sm text-danger">{codeError}</p>}
          {quote?.offer && (
            <p className="mt-1 text-sm text-success" role="status">
              {quote.couponNotUsed
                ? t(locale, "offerBetter", { label: offerLabel(locale, quote.offer), price: money(quote.chargeMinor) })
                : capitalise(t(locale, "offerApplied", { label: offerLabel(locale, quote.offer), amount: money(quote.offer.discountMinor), price: money(quote.chargeMinor) }))}
            </p>
          )}
        </div>
      )}
      {linkGone && (
        <p className="text-danger" role="alert">
          {t(locale, linkGone === "link_used" ? "linkUsed" : "linkGone")}
        </p>
      )}
      {packageRefused && (
        <p className="text-danger" role="alert">
          {t(locale, packageRefused === "package_used_up" ? "packageUsedUp" : packageRefused === "package_expired" ? "packageExpired" : "packageOther")}
        </p>
      )}
      {limited && <p className="text-danger" role="alert">{t(locale, "rateLimited")}</p>}
      {failed && <p className="text-danger" role="alert">{t(locale, "failed")}</p>}
      {expired && <p className="text-danger" role="alert">{t(locale, "holdExpired")}</p>}
      {unavailable && <p className="text-danger" role="alert">{t(locale, "paymentsUnavailable", { host: paid?.hostName ?? t(locale, "thisHost") })}</p>}
      {held ? (
        <div className="grid gap-2 rounded-md bg-warning-bg p-4" role="status">
          <p className="text-text">
            {t(locale, checkoutFailed ? "checkoutFailed" : notPaid ? "notPaid" : "notPaidYet")}{" "}
            {tNodes(locale, "heldUntil", { time: <LocalTime date={held.payment.holdExpiresAt} tz={tz} locale={locale} /> })}
          </p>
          <Button type="button" loading={busy} onClick={() => { const h = held; setHeld(null); void pay(h); }}>{t(locale, "pay", { price: offers ? money(held.payment.amount) : paid?.price ?? "" })}</Button>
        </div>
      ) : (
        <Button type="submit" loading={busy}>{busy ? t(locale, "booking") : paid ? t(locale, paid.deposit ? "continuePayDeposit" : "continuePay", { price: seriesPrice }) : packageToken ? (weeks > 1 ? t(locale, "bookSessions", { n: weeks }) : t(locale, "bookWithPackage")) : t(locale, "bookThisTime")}</Button>
      )}
    </form>
  );
}
