import { send, type Fetch } from "../billing/providers";
import { razorpayApiBase, type HostRazorpayAuth } from "./host-razorpay";

// Orders and payments on the host's own Razorpay account, authenticated as the host.

export type RazorpayPaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";

export interface RazorpayOrder { id: string; amount: number; currency: string; status: string }
export interface RazorpayPayment {
  id: string; orderId: string | null; amount: number; currency: string; status: RazorpayPaymentStatus;
  /** Razorpay's fee including GST, and the GST part of it, in paise; null until Razorpay reports them (after capture). */
  fee: PaymentFee | null;
}
export interface PaymentFee { feeMinor: number; taxMinor: number }
export interface RazorpayRefund { id: string; status: "pending" | "processed" | "failed"; amount: number }
export interface RouteTransfer { account: string; amount: number; currency: string }

export interface RazorpayOrders {
  /** `transfers` (Razorpay Route) sends part of the payment to a linked account as soon as it is captured. */
  createOrder(o: { amount: number; currency: string; receipt: string; notes: Record<string, string>; transfers?: RouteTransfer[] }): Promise<RazorpayOrder>;
  /** Every authorized, captured or failed payment made against the order. */
  orderPayments(orderId: string): Promise<RazorpayPayment[]>;
  getPayment(paymentId: string): Promise<RazorpayPayment>;
  capture(paymentId: string, amount: number, currency: string): Promise<RazorpayPayment>;
  /**
   * Full refund unless `amount` is given. `receipt` makes a repeat of the same refund request fail instead of paying twice.
   * `reverseAll` also pulls back what Route transferred to the host's linked account, for a split payment.
   */
  refund(paymentId: string, o: { amount?: number; receipt: string; notes?: Record<string, string>; reverseAll?: boolean }): Promise<RazorpayRefund>;
  /** Refunds already made on the payment, to tell whether an earlier attempt went through. */
  listRefunds(paymentId: string): Promise<RazorpayRefund[]>;
}

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** The fee only once Razorpay has charged it: a whole, non-negative fee with its GST part no larger than itself. */
export function feeOf(p: Record<string, unknown>): PaymentFee | null {
  const fee = count(p.fee), tax = count(p.tax) ?? 0;
  if (fee === null || tax > fee || (p.status !== "captured" && p.status !== "refunded")) return null;
  return { feeMinor: fee, taxMinor: tax };
}
const toPayment = (p: Record<string, unknown>): RazorpayPayment => ({
  id: p.id as string, orderId: (p.order_id as string) ?? null, amount: p.amount as number, currency: p.currency as string,
  status: p.status as RazorpayPaymentStatus, fee: feeOf(p),
});
const toRefund = (r: Record<string, unknown>): RazorpayRefund => ({ id: r.id as string, status: r.status as RazorpayRefund["status"], amount: r.amount as number });

export function razorpayOrders(auth: HostRazorpayAuth, opts: { baseUrl?: string; fetchImpl?: Fetch } = {}): RazorpayOrders {
  const base = (opts.baseUrl ?? razorpayApiBase()).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const call = (method: string, path: string, body?: unknown) =>
    send(f, `${base}/v1${path}`, {
      method, headers: { ...auth.headers(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }, "Razorpay");
  const id = encodeURIComponent;
  return {
    async createOrder(o) {
      const r = await call("POST", "/orders", {
        amount: o.amount, currency: o.currency, receipt: o.receipt, notes: o.notes,
        ...(o.transfers?.length ? { transfers: o.transfers.map((t) => ({ ...t, on_hold: false })) } : {}),
      });
      return { id: r.id as string, amount: r.amount as number, currency: r.currency as string, status: r.status as string };
    },
    async orderPayments(orderId) {
      const r = await call("GET", `/orders/${id(orderId)}/payments`);
      return ((r.items as Record<string, unknown>[] | undefined) ?? []).map(toPayment);
    },
    async getPayment(paymentId) { return toPayment(await call("GET", `/payments/${id(paymentId)}`)); },
    async capture(paymentId, amount, currency) { return toPayment(await call("POST", `/payments/${id(paymentId)}/capture`, { amount, currency })); },
    async refund(paymentId, { reverseAll, ...o }) {
      return toRefund(await call("POST", `/payments/${id(paymentId)}/refund`, { ...o, speed: "normal", ...(reverseAll ? { reverse_all: 1 } : {}) }));
    },
    async listRefunds(paymentId) {
      const r = await call("GET", `/payments/${id(paymentId)}/refunds`);
      return ((r.items as Record<string, unknown>[] | undefined) ?? []).map(toRefund);
    },
  };
}
