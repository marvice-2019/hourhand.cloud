import { BillingApiError, send, type Fetch } from "../billing/providers";
import { razorpayApiBase, type HostRazorpayAuth } from "../payments/host-razorpay";

// The payment side of memberships, on the host's own account. Everything else in src/lib/memberships talks to this
// interface and to the provider-neutral MembershipEvent, so Stripe subscriptions (via Stripe Connect) can plug in as a
// second implementation without touching the credit, rollover or booking logic.

export type MembershipProviderName = "razorpay";

/** The provider's own status word, as stored on memberships.status. */
export type MembershipStatus = "created" | "authenticated" | "active" | "pending" | "halted" | "paused" | "cancelled" | "completed" | "expired";

export interface ProviderSubscription { id: string; status: MembershipStatus; shortUrl: string | null }

export interface MembershipProvider {
  name: MembershipProviderName;
  /** The public key the browser opens Checkout with. */
  publicKey: string;
  /** A monthly plan at this price. Provider plans can't be edited, so a new price means a new plan. */
  createPlan(p: { name: string; amountMinor: number; currency: string; notes: Record<string, string> }): Promise<{ id: string }>;
  /**
   * A subscription the client authenticates (card e-mandate or UPI Autopay) on the provider's page or Checkout. With
   * `firstMonth`, the first plan charge falls on `firstMonth.startAt` and the client pays `firstMonth.amountMinor` (the
   * discounted first month) once, when they authenticate.
   */
  createSubscription(p: {
    planId: string; totalCount: number; notes: Record<string, string>;
    firstMonth?: { startAt: Date; amountMinor: number; currency: string; label: string };
  }): Promise<ProviderSubscription>;
  /** atPeriodEnd: stop renewing and end when the paid month runs out; otherwise end now. */
  cancel(subscriptionId: string, atPeriodEnd: boolean): Promise<ProviderSubscription>;
}

/** What a webhook means for a membership, whatever the provider. */
export interface MembershipEvent {
  eventId: string;
  /** invoice_paid: an invoice on the subscription was paid; it is how a discounted first month's upfront payment shows up. */
  type: "authenticated" | "activated" | "charged" | "invoice_paid" | "pending" | "halted" | "cancelled" | "completed" | "paused" | "resumed" | "other";
  subscriptionId: string | null;
  status: MembershipStatus | null;
  currentStart: Date | null;
  currentEnd: Date | null;
  /** When the provider says it happened, to apply status changes in order. */
  createdAt: Date;
  /** For charged: the payment that was taken. */
  payment: { id: string; amount: number; currency: string; status: string } | null;
}

/** Monthly renewals for 10 years; the client can cancel at any time. Razorpay needs a fixed count. */
export const TOTAL_MONTHS = 120;

const STATUSES = new Set<MembershipStatus>(["created", "authenticated", "active", "pending", "halted", "paused", "cancelled", "completed", "expired"]);
const toStatus = (s: unknown): MembershipStatus | null => (typeof s === "string" && STATUSES.has(s as MembershipStatus) ? (s as MembershipStatus) : null);
const toSub = (s: Record<string, unknown>): ProviderSubscription => ({
  id: s.id as string, status: toStatus(s.status) ?? "created", shortUrl: typeof s.short_url === "string" ? s.short_url : null,
});

/** Razorpay Subscriptions (https://razorpay.com/docs/api/payments/subscriptions/) authenticated as the host. */
export function razorpayMembershipProvider(auth: HostRazorpayAuth, opts: { baseUrl?: string; fetchImpl?: Fetch } = {}): MembershipProvider {
  const base = (opts.baseUrl ?? razorpayApiBase()).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const call = (method: string, path: string, body?: unknown) =>
    send(f, `${base}/v1${path}`, {
      method, headers: { ...auth.headers(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }, "Razorpay");
  return {
    name: "razorpay",
    publicKey: auth.keyId,
    async createPlan(p) {
      const r = await call("POST", "/plans", { period: "monthly", interval: 1, item: { name: p.name, amount: p.amountMinor, currency: p.currency }, notes: p.notes });
      if (typeof r.id !== "string") throw new BillingApiError("Razorpay returned no plan id", null, false);
      return { id: r.id };
    },
    async createSubscription(p) {
      // No start_at: the subscription starts once the client authenticates, and the first month is charged then.
      // With a discounted first month: start_at a month out, and the discounted amount as an upfront addon, which
      // Razorpay collects in the authentication payment (and does not refund, unlike the plain ₹5 authorisation).
      // customer_notify: Razorpay emails/SMSes the client about the mandate and each charge.
      const first = p.firstMonth
        ? { start_at: Math.floor(p.firstMonth.startAt.getTime() / 1000), addons: [{ item: { name: p.firstMonth.label.slice(0, 100), amount: p.firstMonth.amountMinor, currency: p.firstMonth.currency } }] }
        : {};
      const r = await call("POST", "/subscriptions", { plan_id: p.planId, total_count: p.totalCount, quantity: 1, customer_notify: true, notes: p.notes, ...first });
      if (typeof r.id !== "string") throw new BillingApiError("Razorpay returned no subscription id", null, false);
      return toSub(r);
    },
    async cancel(id, atPeriodEnd) {
      return toSub(await call("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atPeriodEnd }));
    },
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const unix = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);

const RAZORPAY_TYPES: Record<string, MembershipEvent["type"]> = {
  "subscription.authenticated": "authenticated", "subscription.activated": "activated", "subscription.charged": "charged",
  "subscription.pending": "pending", "subscription.halted": "halted", "subscription.cancelled": "cancelled",
  "subscription.completed": "completed", "subscription.paused": "paused", "subscription.resumed": "resumed",
};

/** A Razorpay webhook body (already signature-checked) as a MembershipEvent. Null for a body that isn't an event. */
export function parseRazorpayMembershipEvent(body: Json, eventIdHeader: string | null, now: Date): MembershipEvent | null {
  const event = str(body.event);
  if (!event) return null;
  const payload = obj(body.payload);
  if (event === "invoice.paid") {
    // A paid invoice on a subscription. Only a subscription's invoices matter here; its amount and payment id stand in
    // for the payment, and "paid" means the money was captured.
    const inv = obj(obj(payload.invoice).entity);
    const subscriptionId = str(inv.subscription_id);
    const paymentId = str(inv.payment_id) ?? str(obj(obj(payload.payment).entity).id);
    return {
      eventId: eventIdHeader ?? `${event}:${str(inv.id) ?? "none"}:${String(body.created_at ?? "")}`,
      type: subscriptionId ? "invoice_paid" : "other", subscriptionId, status: null, currentStart: null, currentEnd: null,
      createdAt: unix(body.created_at) ?? now,
      payment: paymentId ? {
        id: paymentId, amount: Number(inv.amount_paid ?? inv.amount), currency: String(inv.currency ?? ""), status: inv.status === "paid" ? "captured" : String(inv.status ?? ""),
      } : null,
    };
  }
  const sub = obj(obj(payload.subscription).entity);
  const pay = obj(obj(payload.payment).entity);
  const subscriptionId = event.startsWith("subscription.") ? str(sub.id) : null;
  const createdAt = unix(body.created_at) ?? now;
  // Without the header, type + subscription + payment + time identify a delivery well enough to drop repeats.
  const eventId = eventIdHeader ?? `${event}:${subscriptionId ?? "none"}:${str(pay.id) ?? "none"}:${String(body.created_at ?? "")}`;
  return {
    eventId, type: RAZORPAY_TYPES[event] ?? "other", subscriptionId, status: toStatus(sub.status),
    currentStart: unix(sub.current_start), currentEnd: unix(sub.current_end), createdAt,
    payment: str(pay.id) ? { id: pay.id as string, amount: Number(pay.amount), currency: String(pay.currency ?? ""), status: String(pay.status ?? "") } : null,
  };
}
