import { createHash } from "node:crypto";
import type pg from "pg";
import { LIMITS, type Plan } from "../billing/plans";
import { COUPON_LIMITS, type createRateLimiter } from "../rate-limit";
import {
  appliesTo, campaignLive, CODE_PATTERN, FIXED_CURRENCY, normaliseCode, pickBest, slidingCharge, usableIn,
  type AdjustmentKind, type Candidate, type Discount, type SlidingScale,
} from "./pricing";

// Offers on paid event types and packages: coupon codes, a first-session discount, sliding-scale prices and dated
// campaigns. resolvePrice is the one entry point the payment code calls, at the single place each charge is worked out
// (handleCreateBooking for a booking, startPurchase for a package). Everything here trusts the browser for two things
// only, the code typed and the sliding-scale amount picked, and checks both.

type Db = Pick<pg.Pool, "query">;
type Limiter = Pick<ReturnType<typeof createRateLimiter>, "take">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN = 60_000;

/** How long a coupon use is held for an order that has no booking or purchase behind it yet. */
const UNLINKED_HOLD_MS = 2 * MIN;
/** A package checkout has no hold of its own; its coupon use is held this long while it is pending. */
const PACKAGE_HOLD_MS = 20 * MIN;

/**
 * What is being priced. `currency` is the price's ISO code, INR when left out. Rupee amounts (fixed codes, campaigns,
 * first-session discounts, sliding scales) apply only to INR prices; percent offers apply in any currency.
 */
export type PriceItem = { kind: "event_type" | "package"; id: string; listMinor: number; currency?: string };
const currencyOf = (item: PriceItem) => (item.currency ?? FIXED_CURRENCY).toUpperCase();

/** The adjustment a booking or purchase got, as the guest, the confirmation and the invoice explain it. */
export interface AppliedOffer {
  kind: AdjustmentKind;
  label: string;
  code: string | null;
  listMinor: number;
  discountMinor: number;
  chargeMinor: number;
}

export type ResolvedPrice =
  | { ok: true; listMinor: number; chargeMinor: number; offer: AppliedOffer | null; couponNotUsed?: boolean }
  | { ok: false; status: 400 | 429; body: { error: string; fields?: Record<string, string> } };

export interface ResolvePriceInput {
  hostId: string;
  plan: Plan;
  item: PriceItem;
  /** The guest's email; first-session eligibility and per-email coupon limits go by it. */
  email: string;
  couponCode: string | null;
  /** The sliding-scale amount the guest picked, in paise. */
  payMinor: number | null;
  /** The booking or purchase request's own key: the adjustment is recorded under it. */
  idempotencyKey: string;
  now: Date;
  limit?: { clientKey: string; limiter: Limiter };
  /**
   * true when an order is being made: the adjustment is recorded and a coupon use held. false for a quote shown on the
   * page: nothing is written, and the first-session discount isn't looked at (it would tell anyone whether an email
   * has booked this host before).
   */
  reserve: boolean;
  /**
   * How many sessions this price is for: a weekly series charges it once per week. A first-session discount is for one
   * session, so a series doesn't get it; campaigns, coupons and a sliding-scale pick apply to each week.
   */
  sessions?: number;
}

/** A purchase refused for its offer (a bad code, too many tries): the handler answers with this status and body. */
export class OfferRefusedError extends Error {
  constructor(readonly status: 400 | 429, readonly body: { error: string; fields?: Record<string, string> }) {
    super(`Offer refused: ${body.error}`);
    this.name = "OfferRefusedError";
  }
}

export const COUPON_INVALID = "That code doesn't work for this booking.";
const SLIDING_NO_COUPON = "Codes can't be used with pay-what-you-can pricing.";

const refuse = (status: 400 | 429, error: string, fields?: Record<string, string>): ResolvedPrice => ({ ok: false, status, body: { error, ...(fields ? { fields } : {}) } });

/** The order behind an application: the booking (event types) or purchase (packages) made with the same key. */
const BOOKING = "select 1 from bookings b where a.item_kind = 'event_type' and b.host_id = a.host_id and b.idempotency_key = a.idempotency_key";
const PURCHASE = "select 1 from package_purchases pp where a.item_kind = 'package' and pp.host_id = a.host_id and pp.idempotency_key = a.idempotency_key";

/** Used: the payment went through (a late payment on a booking the system had released is refunded, so it isn't). */
const USED = `(exists (select 1 from bookings b join payments p on p.booking_id = b.id
    where a.item_kind = 'event_type' and b.host_id = a.host_id and b.idempotency_key = a.idempotency_key
      and p.kind = 'payment' and p.paid_at is not null and b.cancelled_by is distinct from 'system')
  or exists (${PURCHASE} and pp.status = 'paid'))`;

/** Reserved at $NOW: checkout under way, or the order not made yet. A lapsed hold or failed payment releases it. */
const reservedAt = (now: string) => `(exists (${BOOKING} and b.status = 'pending_payment' and b.hold_expires_at > ${now})
  or exists (${PURCHASE} and pp.status = 'pending' and a.reserved_until > ${now})
  or (a.reserved_until > ${now} and not exists (${BOOKING}) and not exists (${PURCHASE})))`;

const liveAt = (now: string) => `(${USED} or ${reservedAt(now)})`;

/** Where an application stands: a used coupon counts for good, a reserved one until its checkout ends. */
export async function applicationState(db: Db, applicationId: string, now: Date): Promise<"used" | "reserved" | "released" | null> {
  const { rows: [r] } = await db.query(
    `select ${USED} as used, ${reservedAt("$2")} as reserved from offer_applications a where a.id = $1`, [applicationId, now]);
  if (!r) return null;
  return r.used ? "used" : r.reserved ? "reserved" : "released";
}

/** A coupon's uses: paid for, and held by a checkout under way. Optionally the same for one email. */
export async function couponUses(db: Db, couponId: string, now: Date, email = ""): Promise<{ used: number; reserved: number; byEmail: number }> {
  const { rows: [r] } = await db.query(
    `select count(*) filter (where ${USED})::int as used, count(*) filter (where not ${USED} and ${reservedAt("$2")})::int as reserved,
       count(*) filter (where a.email = $3 and ${liveAt("$2")})::int as by_email
     from offer_applications a where a.coupon_id = $1`, [couponId, now, email]);
  return { used: r.used, reserved: r.reserved, byEmail: r.by_email };
}

interface CouponRow { id: string; code: string; discount_kind: Discount["kind"]; discount_value: number; expires_at: Date | null; max_uses: number | null; max_uses_per_email: number | null; event_type_ids: string[]; package_ids: string[] }

/** Whether a coupon can be used by this email on this item right now (uses counted inside the caller's transaction). */
async function couponUsable(db: Db, c: CouponRow, item: PriceItem, email: string, now: Date): Promise<boolean> {
  if (c.expires_at && c.expires_at.getTime() <= now.getTime()) return false;
  if (!usableIn({ kind: c.discount_kind, value: c.discount_value }, currencyOf(item))) return false;
  if (!appliesTo({ eventTypeIds: c.event_type_ids, packageIds: c.package_ids }, item)) return false;
  if (c.max_uses === null && c.max_uses_per_email === null) return true;
  const uses = await couponUses(db, c.id, now, email);
  if (c.max_uses !== null && uses.used + uses.reserved >= c.max_uses) return false;
  if (c.max_uses_per_email !== null && uses.byEmail >= c.max_uses_per_email) return false;
  return true;
}

/** Never paid this host for a session (a booking's price or a package), and no first-session discount under way elsewhere. */
async function firstSessionEligible(db: Db, hostId: string, email: string, idempotencyKey: string, now: Date): Promise<boolean> {
  const { rows: [r] } = await db.query(
    `select not exists (
        select 1 from bookings b join invitees i on i.booking_id = b.id join payments p on p.booking_id = b.id
        where b.host_id = $1 and i.email = $2 and p.kind = 'payment' and p.paid_at is not null and b.cancelled_by is distinct from 'system')
      and not exists (select 1 from package_purchases pp where pp.host_id = $1 and pp.guest_email = $2 and pp.status = 'paid')
      and not exists (select 1 from offer_applications a where a.host_id = $1 and a.email = $2 and a.kind = 'first_session'
        and a.idempotency_key <> $3 and ${liveAt("$4")}) as ok`, [hostId, email, idempotencyKey, now]);
  return r.ok as boolean;
}

const hostTimezone = async (db: Db, hostId: string): Promise<string> =>
  ((await db.query("select timezone from users where id = $1", [hostId])).rows[0]?.timezone as string | undefined) ?? "Asia/Kolkata";

export interface Campaign {
  id: string; name: string; banner: string; discount: Discount; startsOn: string; endsOn: string; eventTypeIds: string[]; packageIds: string[]; active: boolean;
}

const CAMPAIGN = "id, name, banner, discount_kind, discount_value, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on, event_type_ids, package_ids, active";
const toCampaign = (r: Record<string, unknown>): Campaign => ({
  id: r.id as string, name: r.name as string, banner: r.banner as string, discount: { kind: r.discount_kind as Discount["kind"], value: r.discount_value as number },
  startsOn: r.starts_on as string, endsOn: r.ends_on as string, eventTypeIds: r.event_type_ids as string[], packageIds: r.package_ids as string[], active: r.active as boolean,
});

/** The host's campaigns on today (in their time zone), best first for `item` when given. */
export async function liveCampaigns(db: Db, hostId: string, now: Date, timezone?: string): Promise<Campaign[]> {
  if (!UUID.test(hostId)) return [];
  const tz = timezone ?? await hostTimezone(db, hostId);
  // A day either side in SQL, the exact day in the host's zone below.
  const { rows } = await db.query(
    `select ${CAMPAIGN} from offer_campaigns where user_id = $1 and active and starts_on <= ($2::timestamptz at time zone 'UTC')::date + 1
       and ends_on >= ($2::timestamptz at time zone 'UTC')::date - 1 order by created_at`, [hostId, now]);
  return rows.map(toCampaign).filter((c) => campaignLive(c, now, tz));
}

export async function slidingScaleFor(db: Db, eventTypeId: string): Promise<SlidingScale | null> {
  if (!UUID.test(eventTypeId)) return null;
  const { rows: [r] } = await db.query("select min_minor, suggested_minor, max_minor, note from offer_sliding_scales where event_type_id = $1", [eventTypeId]);
  return r ? { minMinor: r.min_minor, suggestedMinor: r.suggested_minor, maxMinor: r.max_minor, note: r.note ?? null } : null;
}

export async function firstSessionOffer(db: Db, hostId: string): Promise<Discount | null> {
  if (!UUID.test(hostId)) return null;
  const { rows: [r] } = await db.query("select discount_kind, discount_value from offer_first_session where user_id = $1 and active", [hostId]);
  return r ? { kind: r.discount_kind, value: r.discount_value } : null;
}

const appliedFrom = (r: Record<string, unknown>): AppliedOffer => ({
  kind: r.kind as AdjustmentKind, label: r.label as string, code: (r.code as string | null) ?? null,
  listMinor: r.list_minor as number, discountMinor: r.discount_minor as number, chargeMinor: r.charge_minor as number,
});
const APPLIED = "select a.kind, a.label, c.code, a.list_minor, a.discount_minor, a.charge_minor from offer_applications a left join offer_coupons c on c.id = a.coupon_id";

async function inTx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Rate-limit keys use a hash of the client address, so the limiter's memory never holds an address itself. */
const ipHash = (clientKey: string) => createHash("sha256").update(clientKey).digest("hex").slice(0, 24);

/**
 * The price a guest pays for a booking or package: the list price with at most one adjustment, the best for the guest
 * among a valid coupon, the first-session discount and today's campaigns. A sliding-scale event type charges the amount
 * the guest picked instead, and takes no other adjustment. With `reserve`, the adjustment is recorded under the request's
 * key and a coupon use is held until the payment succeeds or the checkout ends; a repeat of the request gets the same price.
 */
export async function resolvePrice(pool: pg.Pool, input: ResolvePriceInput): Promise<ResolvedPrice> {
  const { hostId, plan, item, now, idempotencyKey, reserve } = input;
  const email = input.email.trim().toLowerCase();
  const code = input.couponCode ? normaliseCode(input.couponCode) : null;
  const list = { ok: true as const, listMinor: item.listMinor, chargeMinor: item.listMinor, offer: null };

  if (code && input.limit) {
    const { clientKey, limiter } = input.limit;
    if (!limiter.take(`coupon-ip:${ipHash(clientKey)}`, COUPON_LIMITS.perIp) || !limiter.take(`coupon-item:${item.kind}:${item.id}`, COUPON_LIMITS.perItem)) {
      return refuse(429, "too_many_requests");
    }
  }

  if (reserve) {
    // A repeat of the same request: the price it got the first time, whatever has changed since.
    const { rows: [again] } = await pool.query(`${APPLIED} where a.host_id = $1 and a.idempotency_key = $2`, [hostId, idempotencyKey]);
    if (again) return { ok: true, listMinor: again.list_minor, chargeMinor: again.charge_minor, offer: appliedFrom(again) };
    const { rows: [made] } = await pool.query(
      item.kind === "event_type" ? "select 1 from bookings where host_id = $1 and idempotency_key = $2" : "select 1 from package_purchases where host_id = $1 and idempotency_key = $2",
      [hostId, idempotencyKey]);
    if (made) return list;
  }

  if (!LIMITS[plan].offers) return code ? refuse(400, "coupon_invalid", { couponCode: COUPON_INVALID }) : list;
  if (code && !CODE_PATTERN.test(code)) return refuse(400, "coupon_invalid", { couponCode: COUPON_INVALID });

  // Pay what you can: the guest's amount is the price, with nothing else on top. Its range is set in rupees, so it
  // applies to INR prices only; on another currency the event type keeps its list price.
  const currency = currencyOf(item);
  const scale = item.kind === "event_type" && currency === FIXED_CURRENCY ? await slidingScaleFor(pool, item.id) : null;
  if (scale) {
    if (code) return refuse(400, "coupon_invalid", { couponCode: SLIDING_NO_COUPON });
    const charge = slidingCharge(scale, input.payMinor);
    if (charge === null) return refuse(400, "invalid_request", { payMinor: `Pick an amount from ₹${scale.minMinor / 100} to ₹${scale.maxMinor / 100}.` });
    const offer: AppliedOffer = { kind: "sliding_scale", label: "Pay what you can", code: null, listMinor: charge, discountMinor: 0, chargeMinor: charge };
    if (reserve) await record(pool, input, email, offer, {});
    return { ok: true, listMinor: charge, chargeMinor: charge, offer };
  }

  const tz = await hostTimezone(pool, hostId);
  const candidates: Candidate[] = (await liveCampaigns(pool, hostId, now, tz))
    .filter((c) => appliesTo(c, item))
    .map((c) => ({ kind: "campaign", label: c.name, discount: c.discount, campaignId: c.id }));
  // First session is for a client's first paid session, so it applies to event types, not packages.
  const first = reserve && item.kind === "event_type" && email && (input.sessions ?? 1) <= 1 ? await firstSessionOffer(pool, hostId) : null;
  if (first && await firstSessionEligible(pool, hostId, email, idempotencyKey, now)) candidates.push({ kind: "first_session", label: "First-session discount", discount: first });

  let coupon: CouponRow | null = null;
  if (code) {
    const { rows: [c] } = await pool.query(
      `select id, code, discount_kind, discount_value, expires_at, max_uses, max_uses_per_email, event_type_ids, package_ids
       from offer_coupons where user_id = $1 and code = $2 and active`, [hostId, code]);
    if (!c || !(await couponUsable(pool, c, item, email, now))) return refuse(400, "coupon_invalid", { couponCode: COUPON_INVALID });
    coupon = c;
    candidates.push({ kind: "coupon", label: `Code ${c.code}`, code: c.code, couponId: c.id, discount: { kind: c.discount_kind, value: c.discount_value } });
  }

  const best = pickBest(item.listMinor, candidates, currency);
  const couponNotUsed = coupon !== null && best?.candidate.kind !== "coupon";
  if (!best) return { ...list, ...(couponNotUsed ? { couponNotUsed } : {}) };
  const offer: AppliedOffer = {
    kind: best.candidate.kind, label: best.candidate.label, code: best.candidate.code ?? null,
    listMinor: item.listMinor, discountMinor: best.discountMinor, chargeMinor: item.listMinor - best.discountMinor,
  };
  if (reserve) {
    const kept = await record(pool, input, email, offer, { coupon: best.candidate.kind === "coupon" ? coupon : null, campaignId: best.candidate.campaignId });
    if (!kept.ok) return kept;
    if (!kept.offer) return list;
    if (kept.offer !== offer) return { ok: true, listMinor: kept.offer.listMinor, chargeMinor: kept.offer.chargeMinor, offer: kept.offer };
  }
  return { ok: true, listMinor: item.listMinor, chargeMinor: offer.chargeMinor, offer, ...(couponNotUsed ? { couponNotUsed } : {}) };
}

/**
 * Records the adjustment under the request's key. A coupon's row is locked and its uses counted again first, so two
 * guests can't both take its last use; a first-session discount is checked again under a lock on the host and email.
 * A concurrent repeat of the same request finds the row already there and gets the same price.
 */
async function record(
  pool: pg.Pool, input: ResolvePriceInput, email: string, offer: AppliedOffer, extra: { coupon?: CouponRow | null; campaignId?: string },
): Promise<{ ok: true; offer: AppliedOffer | null } | Extract<ResolvedPrice, { ok: false }>> {
  const { hostId, item, now, idempotencyKey } = input;
  return inTx(pool, async (client) => {
    if (extra.coupon) {
      const { rows: [c] } = await client.query(
        `select id, code, discount_kind, discount_value, expires_at, max_uses, max_uses_per_email, event_type_ids, package_ids
         from offer_coupons where id = $1 and active for update`, [extra.coupon.id]);
      if (!c || !(await couponUsable(client, c, item, email, now))) return refuse(400, "coupon_invalid", { couponCode: COUPON_INVALID }) as Extract<ResolvedPrice, { ok: false }>;
    }
    if (offer.kind === "first_session") {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`first:${hostId}:${email}`]);
      // Someone else got there first: no adjustment after all, rather than a second first session.
      if (!(await firstSessionEligible(client, hostId, email, idempotencyKey, now))) return { ok: true as const, offer: null };
    }
    const holdMs = item.kind === "package" ? PACKAGE_HOLD_MS : UNLINKED_HOLD_MS;
    const { rows: [inserted] } = await client.query(
      `insert into offer_applications (host_id, idempotency_key, item_kind, item_id, kind, coupon_id, campaign_id, email, label, list_minor, discount_minor, charge_minor, reserved_until)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (host_id, idempotency_key) do nothing returning id`,
      [hostId, idempotencyKey, item.kind, item.id, offer.kind, extra.coupon?.id ?? null, extra.campaignId ?? null, email, offer.label,
        offer.listMinor, offer.discountMinor, offer.chargeMinor, new Date(now.getTime() + holdMs)]);
    if (inserted) return { ok: true as const, offer };
    const { rows: [again] } = await client.query(`${APPLIED} where a.host_id = $1 and a.idempotency_key = $2`, [hostId, idempotencyKey]);
    return { ok: true as const, offer: appliedFrom(again) };
  });
}

/** The adjustment on a booking, for its confirmation page, emails and invoice. Sliding-scale picks carry no discount. */
export async function offerForBooking(db: Db, bookingId: string): Promise<AppliedOffer | null> {
  if (!UUID.test(bookingId)) return null;
  const { rows: [r] } = await db.query(
    `${APPLIED} join bookings b on b.host_id = a.host_id and b.idempotency_key = a.idempotency_key where b.id = $1 and a.item_kind = 'event_type'`, [bookingId]);
  return r ? appliedFrom(r) : null;
}

export async function offerForPurchase(db: Db, purchaseId: string): Promise<AppliedOffer | null> {
  if (!UUID.test(purchaseId)) return null;
  const { rows: [r] } = await db.query(
    `${APPLIED} join package_purchases pp on pp.host_id = a.host_id and pp.idempotency_key = a.idempotency_key where pp.id = $1 and a.item_kind = 'package'`, [purchaseId]);
  return r ? appliedFrom(r) : null;
}

/** What the guest's page shows before they type anything: the price after today's best campaign, and the sliding scale. */
export interface PagePricing {
  listMinor: number;
  campaign: { name: string; banner: string; chargeMinor: number; discountMinor: number } | null;
  sliding: SlidingScale | null;
  firstSession: Discount | null;
  /** The host has at least one live coupon that could apply here, so the page offers a code box. */
  coupons: boolean;
}

export async function pagePricing(db: Db, hostId: string, plan: Plan, item: PriceItem, now: Date): Promise<PagePricing> {
  const none: PagePricing = { listMinor: item.listMinor, campaign: null, sliding: null, firstSession: null, coupons: false };
  if (!LIMITS[plan].offers || !UUID.test(hostId)) return none;
  const currency = currencyOf(item);
  const sliding = item.kind === "event_type" && currency === FIXED_CURRENCY ? await slidingScaleFor(db, item.id) : null;
  if (sliding) return { ...none, sliding };
  const campaigns = (await liveCampaigns(db, hostId, now)).filter((c) => appliesTo(c, item));
  const best = pickBest(item.listMinor, campaigns.map((c) => ({ kind: "campaign" as const, label: c.name, discount: c.discount, campaignId: c.id })), currency);
  const campaign = best ? campaigns.find((c) => c.id === best.candidate.campaignId) ?? null : null;
  const { rows: [{ coupons }] } = await db.query(
    `select exists (select 1 from offer_coupons where user_id = $1 and active and (expires_at is null or expires_at > $2)
       and ($5 = 'INR' or discount_kind = 'percent')
       and ((event_type_ids = '{}' and package_ids = '{}') or $3::uuid = any(case when $4 = 'event_type' then event_type_ids else package_ids end))) as coupons`,
    [hostId, now, item.id, item.kind, currency]);
  const first = item.kind === "event_type" ? await firstSessionOffer(db, hostId) : null;
  return {
    listMinor: item.listMinor, sliding: null, coupons,
    campaign: campaign && best ? { name: campaign.name, banner: campaign.banner, chargeMinor: item.listMinor - best.discountMinor, discountMinor: best.discountMinor } : null,
    firstSession: first && usableIn(first, currency) ? first : null,
  };
}

/** The banner for the host's own page: today's first live campaign, when offers are on for their plan. */
export async function campaignBanner(db: Db, hostId: string, plan: Plan, now: Date): Promise<{ name: string; banner: string; endsOn: string } | null> {
  if (!LIMITS[plan].offers) return null;
  const [c] = await liveCampaigns(db, hostId, now);
  return c ? { name: c.name, banner: c.banner, endsOn: c.endsOn } : null;
}

/** Reads the two things a guest may send with a booking or purchase: a coupon code and a sliding-scale amount (paise). */
export function parseOfferInput(input: unknown): { couponCode: string | null; payMinor: number | null } {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const code = typeof body.couponCode === "string" ? body.couponCode.trim().slice(0, 40) : "";
  const pay = body.payMinor;
  return { couponCode: code || null, payMinor: typeof pay === "number" && Number.isFinite(pay) ? Math.round(pay) : null };
}
