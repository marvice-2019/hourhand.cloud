import type pg from "pg";
import { audit, can, type Actor } from "../admin/roles";
import type { Currency } from "../billing/plans";
import { BillingApiError } from "../billing/providers";
import { seal, unseal } from "../crypto/seal";
import { keyPairAuth, maskKeyId, type HostRazorpayAuth, type PlatformCollection, type RazorpayMode } from "./host-razorpay";
import type { RouteTransfer } from "./razorpay-orders";
import { applicationFeeMinor } from "./stripe-connect";

// How a host's guests pay (B18). By default ('own') they pay the host's own Razorpay or Stripe, as before. A super admin
// can move a host to 'split' (guests pay Hourhand's Razorpay and Route sends the host's share to their linked account at
// once) or 'platform' (guests pay Hourhand's Razorpay and Hourhand pays the host out by hand, recorded in a ledger).
// Hourhand's own key pair is sealed like hosts' keys and only its masked key id is ever shown. Every change is audited.
// For a Stripe host, 'split' takes the commission as Stripe Connect's application fee; 'platform' doesn't apply to Stripe.

type Db = Pick<pg.Pool, "query">;

export type PaymentMode = "own" | "split" | "platform";
export const PAYMENT_MODES: readonly PaymentMode[] = ["own", "split", "platform"];

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;
const ROUTE_ACCOUNT = /^acc_[A-Za-z0-9]{6,32}$/;
const DEFAULT_COMMISSION = "payments.commission_bps";
/** The highest commission a super admin can set: half of each payment. */
export const MAX_COMMISSION_BPS = 5000;

export type PlatformPaymentsProblem =
  | "not_allowed" | "format" | "rejected" | "unreachable" | "busy" | "no_account" | "bad_mode" | "bad_commission" | "no_route_account" | "bad_amount";

export class PlatformPaymentsRefused extends Error {
  constructor(readonly code: PlatformPaymentsProblem, message: string = code) {
    super(message);
    this.name = "PlatformPaymentsRefused";
  }
}

const allowed = (actor: Actor) => {
  if (!can(actor.role, "manage_payments")) throw new PlatformPaymentsRefused("not_allowed", "Only a super admin can change payments.");
};
const aad = (keyId: string) => `platform-razorpay:${keyId}`;

/** Hourhand's share of an amount, in the same minor units. */
export const commissionOf = (amountMinor: number, bps: number): number => Math.floor((amountMinor * bps) / 10_000);

// ---- Hourhand's own Razorpay -------------------------------------------------------------------------------------------

/** Checks the pair with Razorpay, then stores it sealed. Nothing is stored unless Razorpay accepted it. */
export async function savePlatformRazorpay(
  db: Db, key: Buffer, actor: Actor, keyId: string, keySecret: string, verify: (auth: HostRazorpayAuth) => Promise<void>,
): Promise<{ mode: RazorpayMode }> {
  allowed(actor);
  keyId = keyId.trim();
  keySecret = keySecret.trim();
  const m = KEY_ID.exec(keyId);
  if (!m) throw new PlatformPaymentsRefused("format", "That doesn't look like a Razorpay key id (it starts with rzp_test_ or rzp_live_).");
  if (!keySecret || keySecret.length > 128) throw new PlatformPaymentsRefused("format", "Paste the key secret that Razorpay showed with this key id.");
  try {
    await verify(keyPairAuth(keyId, keySecret));
  } catch (error) {
    if (error instanceof BillingApiError && (error.status === 401 || error.status === 403)) throw new PlatformPaymentsRefused("rejected", "Razorpay didn't accept this key pair.");
    throw new PlatformPaymentsRefused("unreachable", `Couldn't check the keys with Razorpay: ${(error as Error).message}`);
  }
  // Keys can't change under a payment that is still being confirmed or refunded: those need the account that took them.
  if (await platformPaymentsInFlight(db, keyId)) throw new PlatformPaymentsRefused("busy", "A guest's payment to Hourhand is still being confirmed or refunded.");
  const mode = m[1] as RazorpayMode;
  await db.query(
    `insert into platform_gateways (provider, credentials_encrypted, public_id, mode, updated_by) values ('razorpay', $1, $2, $3, $4)
     on conflict (provider) do update set credentials_encrypted = excluded.credentials_encrypted, public_id = excluded.public_id,
       mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now()`,
    [seal(key, { keyId, keySecret }, aad(keyId)), keyId, mode, actor.id]);
  await audit(db, actor, "payments.gateway.save", "gateway", "razorpay", { key: maskKeyId(keyId), mode });
  return { mode };
}

/** True while a payment Hourhand collected on another key than `keepKeyId` (any key, if none) still needs its account. */
async function platformPaymentsInFlight(db: Db, keepKeyId: string | null): Promise<boolean> {
  const { rows: [current] } = await db.query("select public_id from platform_gateways where provider = 'razorpay'");
  if (!current || current.public_id === keepKeyId) return false;
  const { rows } = await db.query(
    `select 1 from payments where collected_via = 'platform' and provider = 'razorpay' and (status in ('pending', 'refund_pending') or refund_due_minor > 0)
     union all select 1 from package_purchases where collected_via = 'platform' and provider = 'razorpay' and status = 'pending' limit 1`);
  return rows.length > 0;
}

/** Hourhand's Razorpay access, or null when none is set. Throws if the stored value was tampered with. */
export async function loadPlatformRazorpay(db: Db, key: Buffer): Promise<(HostRazorpayAuth & { mode: RazorpayMode }) | null> {
  const { rows: [r] } = await db.query("select credentials_encrypted, public_id, mode from platform_gateways where provider = 'razorpay'");
  if (!r) return null;
  const pair = unseal<{ keyId: string; keySecret: string }>(key, r.credentials_encrypted, aad(r.public_id));
  return { ...keyPairAuth(pair.keyId, pair.keySecret), mode: r.mode };
}

/** What the admin page shows: the masked key id and its mode, never the secret. */
export async function platformRazorpayStatus(db: Db): Promise<{ key: string; mode: RazorpayMode; updatedAt: Date } | null> {
  const { rows: [r] } = await db.query("select public_id, mode, updated_at from platform_gateways where provider = 'razorpay'");
  return r ? { key: maskKeyId(r.public_id), mode: r.mode, updatedAt: r.updated_at } : null;
}

/** Removes Hourhand's keys, unless a payment it took is still being confirmed or refunded. */
export async function removePlatformRazorpay(db: Db, actor: Actor): Promise<void> {
  allowed(actor);
  if (await platformPaymentsInFlight(db, null)) throw new PlatformPaymentsRefused("busy", "A guest's payment to Hourhand is still being confirmed or refunded.");
  const { rowCount } = await db.query("delete from platform_gateways where provider = 'razorpay'");
  if (rowCount) await audit(db, actor, "payments.gateway.remove", "gateway", "razorpay");
}

// ---- Commission and each host's mode --------------------------------------------------------------------------------

export async function defaultCommissionBps(db: Db): Promise<number> {
  const { rows: [r] } = await db.query("select value from platform_settings where key = $1", [DEFAULT_COMMISSION]);
  const n = Number(r?.value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_COMMISSION_BPS ? n : 0;
}

const validBps = (bps: number) => Number.isInteger(bps) && bps >= 0 && bps <= MAX_COMMISSION_BPS;

export async function setDefaultCommissionBps(db: Db, actor: Actor, bps: number): Promise<void> {
  allowed(actor);
  if (!validBps(bps)) throw new PlatformPaymentsRefused("bad_commission", `Enter a commission from 0% to ${MAX_COMMISSION_BPS / 100}%.`);
  const before = await defaultCommissionBps(db);
  await db.query(
    `insert into platform_settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [DEFAULT_COMMISSION, String(bps), actor.id]);
  await audit(db, actor, "payments.commission.default", null, null, { from: before, to: bps });
}

export interface HostPaymentSettings { mode: PaymentMode; commissionBps: number | null; routeAccount: string | null }

export async function hostPaymentSettings(db: Db, hostId: string): Promise<HostPaymentSettings | null> {
  const { rows: [r] } = await db.query("select payment_mode, commission_bps, route_account_id from users where id = $1", [hostId]);
  return r ? { mode: r.payment_mode, commissionBps: r.commission_bps, routeAccount: r.route_account_id } : null;
}

/** Sets how a host's guests pay. Payments already started keep the account that took them. */
export async function setHostPaymentSettings(db: Db, actor: Actor, hostId: string, next: HostPaymentSettings): Promise<void> {
  allowed(actor);
  if (!PAYMENT_MODES.includes(next.mode)) throw new PlatformPaymentsRefused("bad_mode");
  if (next.commissionBps !== null && !validBps(next.commissionBps)) {
    throw new PlatformPaymentsRefused("bad_commission", `Enter a commission from 0% to ${MAX_COMMISSION_BPS / 100}%, or leave it empty for the default.`);
  }
  const routeAccount = next.routeAccount?.trim() || null;
  if (routeAccount && !ROUTE_ACCOUNT.test(routeAccount)) throw new PlatformPaymentsRefused("format", "A Razorpay Route account id starts with acc_.");
  if (next.mode === "split" && !routeAccount) throw new PlatformPaymentsRefused("no_route_account", "Splitting needs the host's Razorpay Route linked account id (acc_…).");
  const before = await hostPaymentSettings(db, hostId);
  if (!before) throw new PlatformPaymentsRefused("no_account", "No such host.");
  await db.query("update users set payment_mode = $2, commission_bps = $3, route_account_id = $4 where id = $1", [hostId, next.mode, next.commissionBps, routeAccount]);
  await audit(db, actor, "host.payments.update", "user", hostId, { from: before, to: { ...next, routeAccount } });
}

/**
 * The Razorpay account that takes a host's new payments: the host's own (from `own`) in 'own' mode, Hourhand's otherwise,
 * marked with how the money is shared. Null when that account isn't set up, or 'split' has no Route account, so guests
 * see payments as unavailable rather than paying the wrong account.
 */
export async function collectingAuth(db: Db, key: Buffer, hostId: string, own: () => Promise<HostRazorpayAuth | null>): Promise<HostRazorpayAuth | null> {
  const s = await hostPaymentSettings(db, hostId);
  if (!s || s.mode === "own") return own();
  if (s.mode === "split" && !s.routeAccount) return null;
  const platform = await loadPlatformRazorpay(db, key);
  if (!platform) return null;
  const collection: PlatformCollection = { mode: s.mode, commissionBps: s.commissionBps ?? await defaultCommissionBps(db), routeAccount: s.mode === "split" ? s.routeAccount : null };
  return { ...platform, collection };
}

/** What a new Razorpay payment records about who took it, and the Route transfer to put on its order. */
export function collectionTerms(auth: HostRazorpayAuth, amountMinor: number, currency: string): {
  collectedVia: "host" | "platform"; commissionMinor: number; transferAccount: string | null; transfers?: RouteTransfer[];
} {
  const c = auth.collection;
  if (!c) return { collectedVia: "host", commissionMinor: 0, transferAccount: null };
  const commissionMinor = commissionOf(amountMinor, c.commissionBps);
  if (c.mode !== "split" || !c.routeAccount) return { collectedVia: "platform", commissionMinor, transferAccount: null };
  const share = amountMinor - commissionMinor;
  return { collectedVia: "platform", commissionMinor, transferAccount: c.routeAccount, transfers: share > 0 ? [{ account: c.routeAccount, amount: share, currency }] : [] };
}

/** Hourhand's application fee on a Stripe payment: the host's commission in 'split' mode, Hourhand's standard fee otherwise. */
export async function stripeApplicationFee(db: Db, hostId: string, amountMinor: number): Promise<number> {
  const s = await hostPaymentSettings(db, hostId);
  if (s?.mode !== "split") return applicationFeeMinor(amountMinor);
  return commissionOf(amountMinor, s.commissionBps ?? await defaultCommissionBps(db));
}

// ---- Payouts for 'platform' mode ------------------------------------------------------------------------------------

export interface HostBalance {
  hostId: string; email: string; name: string | null; mode: PaymentMode; currency: Currency;
  collectedMinor: number; refundedMinor: number; commissionMinor: number; paidOutMinor: number; owedMinor: number;
}

/**
 * What Hourhand owes each host whose guests paid Hourhand in full (not split): each payment's amount less what was
 * refunded and Hourhand's commission (never below zero for one payment), less what was already paid out.
 */
export async function hostBalances(db: Db): Promise<HostBalance[]> {
  const { rows } = await db.query(
    `with taken as (
       select host_id, currency, amount_minor as amount, refunded_minor as refunded, commission_minor as commission from payments
       where collected_via = 'platform' and transfer_account is null and status in ('paid', 'refund_pending', 'refunded')
       union all
       select host_id, currency, price_minor, 0, commission_minor from package_purchases
       where collected_via = 'platform' and transfer_account is null and status = 'paid'
       union all
       -- Paid questions (B19); a declined one is refunded in full, so it isn't owed.
       select host_id, currency, price_minor, 0, commission_minor from questions
       where collected_via = 'platform' and transfer_account is null and price_minor > 0 and status in ('open', 'answered')),
     owed as (
       select host_id, currency, sum(amount)::int as collected, sum(refunded)::int as refunded, sum(commission)::int as commission,
         sum(greatest(amount - refunded - commission, 0))::int as share
       from taken group by host_id, currency),
     paid as (select host_id, currency, sum(amount_minor)::int as paid_out from host_payouts group by host_id, currency)
     select u.id, u.email::text as email, u.name, u.payment_mode, coalesce(o.currency, p.currency) as currency,
       coalesce(o.collected, 0) as collected, coalesce(o.refunded, 0) as refunded, coalesce(o.commission, 0) as commission,
       coalesce(p.paid_out, 0) as paid_out, coalesce(o.share, 0) - coalesce(p.paid_out, 0) as owed
     from owed o full join paid p on p.host_id = o.host_id and p.currency = o.currency
     join users u on u.id = coalesce(o.host_id, p.host_id)
     order by owed desc, u.email`);
  return rows.map((r) => ({
    hostId: r.id, email: r.email, name: r.name, mode: r.payment_mode, currency: r.currency, collectedMinor: r.collected, refundedMinor: r.refunded,
    commissionMinor: r.commission, paidOutMinor: r.paid_out, owedMinor: r.owed,
  }));
}

/** Records money Hourhand paid a host (by bank transfer or UPI, outside the app). It can't exceed what is owed. */
export async function recordPayout(db: Db, actor: Actor, hostId: string, amountMinor: number, reference: string, currency = "INR"): Promise<void> {
  allowed(actor);
  reference = reference.trim();
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new PlatformPaymentsRefused("bad_amount", "Enter the amount paid.");
  if (!reference || reference.length > 200) throw new PlatformPaymentsRefused("format", "Enter the bank or UPI reference (up to 200 characters).");
  const owed = (await hostBalances(db)).find((b) => b.hostId === hostId && b.currency === currency)?.owedMinor ?? 0;
  if (amountMinor > owed) throw new PlatformPaymentsRefused("bad_amount", "That's more than Hourhand owes this host.");
  const { rows: [p] } = await db.query(
    "insert into host_payouts (host_id, amount_minor, currency, reference, recorded_by) values ($1, $2, $3, $4, $5) returning id", [hostId, amountMinor, currency, reference, actor.id]);
  await audit(db, actor, "host.payout.record", "user", hostId, { payoutId: p.id, amountMinor, currency, reference });
}

export interface Payout { id: string; amountMinor: number; currency: Currency; reference: string; paidAt: Date; recordedBy: string | null }

export async function hostPayouts(db: Db, hostId: string): Promise<Payout[]> {
  const { rows } = await db.query(
    `select p.id, p.amount_minor, p.currency, p.reference, p.paid_at, u.email::text as recorded_by
     from host_payouts p left join users u on u.id = p.recorded_by where p.host_id = $1 order by p.paid_at desc limit 50`, [hostId]);
  return rows.map((r) => ({ id: r.id, amountMinor: r.amount_minor, currency: r.currency, reference: r.reference, paidAt: r.paid_at, recordedBy: r.recorded_by }));
}

/** "10" or "2.5" (per cent) as basis points; "" as null (use the default). NaN for anything else. */
export function parsePercent(raw: string): number | null {
  const t = raw.trim().replace(/%$/, "").trim();
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}
