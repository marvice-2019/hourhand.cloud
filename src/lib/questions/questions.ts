import type pg from "pg";
import { BillingApiError } from "../billing/providers";
import { kickJobs } from "../jobs/kick";
import { authForPayment, type PaymentCheckDeps } from "../payments/booking-payments";
import type { HostRazorpayAuth } from "../payments/host-razorpay";
import { collectionTerms } from "../payments/platform";
import type { RazorpayOrders, RazorpayPayment } from "../payments/razorpay-orders";
import type { QuestionEmailKind } from "../data/notifications";

// Ask a question (B19, like Topmate's Priority DM). A host offers to answer one written question for a price (or free).
// The guest sends it from /<slug>/ask, pays the host's Razorpay (or Hourhand's, B18) and gets a private link (/q/<token>).
// The host answers or declines from their dashboard; the guest gets the answer by email. A declined paid question is
// refunded in full by the job runner, on the account that took the money.

type Db = Pick<pg.Pool, "query">;
const DAY = 86_400_000;
const CURRENCY = "INR";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{48}$/;
export const MAX_QUESTION = 2000;
export const MAX_ANSWER = 5000;
/** The highest price a host can ask for one question: ₹1,00,000. */
export const MAX_PRICE_MINOR = 10_000_000;

export interface QuestionOffer { active: boolean; priceMinor: number; currency: "INR"; responseDays: number; intro: string | null }
export type QuestionStatus = "pending" | "open" | "answered" | "declined" | "failed" | "refund_pending" | "refunded";
export interface Question {
  id: string; token: string; guestName: string; guestEmail: string; question: string; priceMinor: number; currency: "INR"; status: QuestionStatus;
  dueAt: Date | null; answer: string | null; answeredAt: Date | null; createdAt: Date; paidAt: Date | null;
  /** Closed because it was still open a day after it was due (declined or refunded for the host). */
  expired: boolean;
}

const DEFAULT_OFFER: QuestionOffer = { active: false, priceMinor: 0, currency: "INR", responseDays: 3, intro: null };

export async function getOffer(db: Db, hostId: string): Promise<QuestionOffer> {
  const { rows: [r] } = await db.query("select active, price_minor, response_days, intro from question_offers where host_id = $1", [hostId]);
  return r ? { active: r.active, priceMinor: r.price_minor, currency: "INR", responseDays: r.response_days, intro: r.intro } : DEFAULT_OFFER;
}

export class QuestionInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Invalid question input");
    this.name = "QuestionInputError";
  }
}

export async function saveOffer(db: Db, hostId: string, input: { active: boolean; priceMinor: number; responseDays: number; intro: string }): Promise<QuestionOffer> {
  const fields: Record<string, string> = {};
  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0 || input.priceMinor > MAX_PRICE_MINOR) fields.price = "Enter a price from ₹0 (free) to ₹1,00,000.";
  if (input.priceMinor > 0 && input.priceMinor < 100) fields.price = "A paid question costs at least ₹1.";
  if (!Number.isInteger(input.responseDays) || input.responseDays < 1 || input.responseDays > 14) fields.responseDays = "Pick 1 to 14 days.";
  const intro = input.intro.trim();
  if (intro.length > 500) fields.intro = "Keep it to 500 characters.";
  if (Object.keys(fields).length) throw new QuestionInputError(fields);
  await db.query(
    `insert into question_offers (host_id, active, price_minor, response_days, intro) values ($1, $2, $3, $4, $5)
     on conflict (host_id) do update set active = excluded.active, price_minor = excluded.price_minor, response_days = excluded.response_days,
       intro = excluded.intro, updated_at = now()`,
    [hostId, input.active, input.priceMinor, input.responseDays, intro || null]);
  return getOffer(db, hostId);
}

export interface PublicOffer { host: { id: string; name: string; slug: string }; offer: QuestionOffer }

/** A host's offer as guests see it: only while it is on and the host's pages are public (approved, not closed). */
export async function publicOffer(db: Db, slug: string): Promise<PublicOffer | null> {
  const { rows: [r] } = await db.query(
    `select u.id, u.name, u.slug::text as slug, o.price_minor, o.response_days, o.intro
     from users u join question_offers o on o.host_id = u.id
     where u.slug = $1 and o.active and u.deleted_at is null and u.review_status = 'approved'`, [slug]);
  return r ? { host: { id: r.id, name: r.name, slug: r.slug }, offer: { active: true, priceMinor: r.price_minor, currency: "INR", responseDays: r.response_days, intro: r.intro } } : null;
}

const toQuestion = (r: Record<string, unknown>): Question => ({
  id: r.id as string, token: r.token as string, guestName: r.guest_name as string, guestEmail: r.guest_email as string, question: r.question as string,
  priceMinor: r.price_minor as number, currency: "INR", status: r.status as QuestionStatus, dueAt: (r.due_at as Date | null) ?? null,
  answer: (r.answer as string | null) ?? null, answeredAt: (r.answered_at as Date | null) ?? null, createdAt: r.created_at as Date, paidAt: (r.paid_at as Date | null) ?? null,
  expired: r.expired_at != null,
});
const COLUMNS = "id, token, guest_name, guest_email::text as guest_email, question, price_minor, status, due_at, answer, answered_at, created_at, paid_at, expired_at";

/** The guest's own view of their question, by its private token. */
export async function questionByToken(db: Db, token: string): Promise<(Question & { hostName: string; hostSlug: string }) | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query(
    `select ${COLUMNS.split(", ").map((c) => `q.${c}`).join(", ")}, u.name as host_name, u.slug::text as host_slug
     from questions q join users u on u.id = q.host_id where q.token = $1`, [token]);
  return r ? { ...toQuestion(r), hostName: r.host_name, hostSlug: r.host_slug } : null;
}

/** A host's questions, newest first: everything a guest actually sent (not ones whose payment never went through). */
export async function listQuestions(db: Db, hostId: string, limit = 100): Promise<Question[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from questions where host_id = $1 and status not in ('pending', 'failed')
     order by (status = 'open') desc, coalesce(due_at, created_at), created_at desc limit $2`, [hostId, limit]);
  return rows.map(toQuestion);
}

/** Queues an email for a question (the worker renders it from the question's current state). */
async function notify(db: Db, q: { id: string; host_id: string }, kind: QuestionEmailKind, to: string, now: Date) {
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     values (null, $1, 'email', $2, $3, $4, $5) on conflict (dedupe_key) do nothing`, [q.host_id, kind, to, now, `question:${q.id}:${kind}`]);
}

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

export interface QuestionCheckout { orderId: string; keyId: string; amount: number; currency: string }

export class QuestionStartError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "QuestionStartError";
  }
}

/** Opens a question that needs no payment (free, or just paid): the host is told and its answer is due. */
async function openQuestion(client: Db, id: string, now: Date, paid: { paymentId: string } | null): Promise<boolean> {
  const { rows: [q] } = await client.query(
    `update questions q set status = 'open', due_at = $2::timestamptz + o.response_days * interval '1 day', updated_at = $2,
       provider_payment_id = coalesce($3, q.provider_payment_id), paid_at = case when $3::text is null then q.paid_at else $2 end, last_error = null
     from question_offers o where q.id = $1 and o.host_id = q.host_id and q.status in ('pending', 'failed')
     returning q.id, q.host_id, (select email::text from users where id = q.host_id) as host_email`, [id, now, paid?.paymentId ?? null]);
  if (!q) return false;
  await notify(client, q, "question_host", q.host_email, now);
  return true;
}

/**
 * Starts a question: validated, stored once per request key, then either opened (free) or given a Razorpay order on the
 * account that collects for the host (theirs, or Hourhand's under B18). A repeat of the request returns the same question.
 */
export async function startQuestion(
  deps: { pool: pg.Pool; auth: HostRazorpayAuth | null; orders: RazorpayOrders | null },
  found: PublicOffer, input: unknown, now: Date,
): Promise<{ token: string; status: QuestionStatus; payment: QuestionCheckout | null }> {
  const body = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const name = str("name"), email = str("email"), question = str("question"), key = str("idempotencyKey");
  const fields: Record<string, string> = {};
  if (name.length < 1 || name.length > 100) fields.name = "Enter your name (up to 100 characters).";
  if (!EMAIL.test(email) || email.length > 254) fields.email = "Enter a valid email address.";
  if (question.length < 1 || question.length > MAX_QUESTION) fields.question = `Write your question (up to ${MAX_QUESTION} characters).`;
  if (key.length < 8 || key.length > 100) fields.idempotencyKey = "Missing request key.";
  if (Object.keys(fields).length) throw new QuestionInputError(fields);

  const { pool, auth, orders } = deps;
  const price = found.offer.priceMinor;
  if (price > 0 && (!auth || !orders)) throw new QuestionStartError("payments_unavailable", false);
  await pool.query(
    `insert into questions (host_id, idempotency_key, guest_name, guest_email, question, price_minor, currency, status, provider)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) on conflict (host_id, idempotency_key) do nothing`,
    [found.host.id, key, name, email, question, price, CURRENCY, price > 0 ? "razorpay" : null]);
  const { rows: [row] } = await pool.query(
    "select id, token, status, price_minor, provider_order_id from questions where host_id = $1 and idempotency_key = $2", [found.host.id, key]);

  if (row.price_minor === 0) {
    if (row.status === "pending") {
      await inTx(pool, (client) => openQuestion(client, row.id, now, null));
      kickJobs();
      return { token: row.token, status: "open", payment: null };
    }
    return { token: row.token, status: row.status, payment: null };
  }
  if (row.status !== "pending") return { token: row.token, status: row.status, payment: null };
  const checkout = (orderId: string): QuestionCheckout => ({ orderId, keyId: auth!.keyId, amount: row.price_minor, currency: CURRENCY });
  if (row.provider_order_id) return { token: row.token, status: "pending", payment: checkout(row.provider_order_id) };

  // The row stays locked while the order is made, so a concurrent repeat waits and then reuses this order.
  const orderId = await inTx(pool, async (client) => {
    const { rows: [locked] } = await client.query("select provider_order_id from questions where id = $1 for update", [row.id]);
    if (locked.provider_order_id) return locked.provider_order_id as string;
    const terms = collectionTerms(auth!, row.price_minor, CURRENCY);
    let order;
    try {
      order = await orders!.createOrder({ amount: row.price_minor, currency: CURRENCY, receipt: `q-${row.id}`, notes: { question_id: row.id }, transfers: terms.transfers });
    } catch (error) {
      throw new QuestionStartError(`Payment could not start: ${(error as Error).message}`, error instanceof BillingApiError && error.retryable);
    }
    await client.query(
      "update questions set provider_order_id = $2, collected_via = $3, commission_minor = $4, transfer_account = $5, updated_at = now() where id = $1",
      [row.id, order.id, terms.collectedVia, terms.commissionMinor, terms.transferAccount]);
    return order.id;
  });
  return { token: row.token, status: "pending", payment: checkout(orderId) };
}

/** Records a captured payment: the question opens and the host is told. A question already open is left as it is. */
export async function applyQuestionPayment(pool: pg.Pool, id: string, paymentId: string, now: Date): Promise<"open" | "already"> {
  const opened = await inTx(pool, (client) => openQuestion(client, id, now, { paymentId }));
  if (opened) kickJobs();
  return opened ? "open" : "already";
}

export type QuestionVerifyReason = "no_payment" | "bad_signature" | "mismatch" | "not_paid";
export class QuestionVerifyError extends Error {
  constructor(readonly reason: QuestionVerifyReason) {
    super(`Question payment could not be verified: ${reason}`);
    this.name = "QuestionVerifyError";
  }
}

async function captureOnce(orders: RazorpayOrders, paymentId: string, amount: number, currency: string): Promise<RazorpayPayment> {
  try {
    return await orders.capture(paymentId, amount, currency);
  } catch (error) {
    const again = await orders.getPayment(paymentId);
    if (again.status === "captured") return again;
    throw error;
  }
}

/** The account that took (or will take) a question's payment, from its own row. */
export async function questionPaymentRow(db: Db, token: string): Promise<{ id: string; host_id: string; collected_via: string; provider_order_id: string | null; price_minor: number; currency: string } | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query("select id, host_id, collected_via, provider_order_id, price_minor, currency from questions where token = $1", [token]);
  return r ?? null;
}

/** Confirms a question from what Razorpay Checkout handed the browser; amounts come from our row, never the client. */
export async function confirmQuestion(
  deps: { pool: pg.Pool; auth: HostRazorpayAuth; orders: RazorpayOrders }, input: { token: string; paymentId: string; signature: string }, now: Date,
): Promise<"open" | "already"> {
  const row = await questionPaymentRow(deps.pool, input.token);
  if (!row?.provider_order_id) throw new QuestionVerifyError("no_payment");
  if (!deps.auth.verifyPaymentSignature(row.provider_order_id, input.paymentId, input.signature)) throw new QuestionVerifyError("bad_signature");
  let p = await deps.orders.getPayment(input.paymentId);
  if (p.orderId !== row.provider_order_id || p.amount !== row.price_minor || p.currency !== row.currency) throw new QuestionVerifyError("mismatch");
  if (p.status === "authorized") p = await captureOnce(deps.orders, p.id, row.price_minor, row.currency);
  if (p.status !== "captured") throw new QuestionVerifyError("not_paid");
  return applyQuestionPayment(deps.pool, row.id, p.id, now);
}

const RECHECK_MS = 60_000;
export interface QuestionJobResult { checked: number; opened: number; failed: number; refunded: number; errors: number }

/**
 * The job runner's pass over questions: settles pending payments with Razorpay (a guest who paid and closed the tab,
 * or a payment only authorized; with none for a day it fails), and refunds declined paid questions in full.
 */
export async function runQuestionJobs(deps: PaymentCheckDeps & { pool: pg.Pool }, now: Date, limit = 20): Promise<QuestionJobResult> {
  const { pool } = deps;
  const { rows } = await pool.query(
    `with due as (
       select id from questions
       where provider = 'razorpay' and status in ('pending', 'refund_pending') and provider_order_id is not null
         and created_at < $1::timestamptz - $3 * interval '1 millisecond'
         and (checked_at is null or checked_at < $1::timestamptz - $3 * interval '1 millisecond')
       order by checked_at nulls first, created_at limit $2 for update skip locked)
     update questions q set checked_at = $1 from due where q.id = due.id
     returning q.id, q.host_id, q.status, q.collected_via, q.transfer_account, q.provider_order_id, q.provider_payment_id, q.price_minor, q.currency, q.created_at`,
    [now, limit, RECHECK_MS]);
  const result: QuestionJobResult = { checked: rows.length, opened: 0, failed: 0, refunded: 0, errors: 0 };
  for (const r of rows) {
    try {
      const auth = await authForPayment(deps, r);
      if (!auth) {
        await pool.query("update questions set last_error = 'Razorpay disconnected', updated_at = $2 where id = $1", [r.id, now]);
        continue;
      }
      const orders = deps.ordersFor(auth);
      if (r.status === "refund_pending") {
        // Never refund twice: a refund that went through before we could record it is found and recorded.
        const earlier = (await orders.listRefunds(r.provider_payment_id)).filter((x) => x.status !== "failed");
        const refund = earlier[0] ?? await orders.refund(r.provider_payment_id, { receipt: `q-${r.id}`, notes: { question_id: r.id }, ...(r.transfer_account ? { reverseAll: true } : {}) });
        await pool.query("update questions set status = 'refunded', refund_id = $2, last_error = null, updated_at = $3 where id = $1 and status = 'refund_pending'", [r.id, refund.id, now]);
        result.refunded += 1;
        continue;
      }
      const items = await orders.orderPayments(r.provider_order_id);
      const ours = (p: RazorpayPayment) => p.amount === r.price_minor && p.currency === r.currency;
      const captured = items.find((p) => p.status === "captured" && ours(p));
      const authorized = items.find((p) => p.status === "authorized" && ours(p));
      const paid = captured ?? (authorized ? await captureOnce(orders, authorized.id, r.price_minor, r.currency) : null);
      if (paid?.status === "captured") {
        if ((await applyQuestionPayment(pool, r.id, paid.id, now)) === "open") result.opened += 1;
      } else if (now.getTime() - new Date(r.created_at).getTime() > DAY) {
        await pool.query("update questions set status = 'failed', updated_at = $2 where id = $1 and status = 'pending'", [r.id, now]);
        result.failed += 1;
      }
    } catch (error) {
      result.errors += 1;
      await pool.query("update questions set last_error = $2, updated_at = $3 where id = $1", [r.id, ((error as Error).message ?? String(error)).slice(0, 500), now]).catch(() => undefined);
    }
  }
  return result;
}

export type QuestionActionRefused = "not_found" | "not_open" | "empty" | "too_long";

/** The host's answer: the question is answered and the guest gets it by email. Only an open question can be answered. */
export async function answerQuestion(pool: pg.Pool, hostId: string, id: string, answer: string, now: Date): Promise<"answered" | QuestionActionRefused> {
  const text = answer.trim();
  if (!text) return "empty";
  if (text.length > MAX_ANSWER) return "too_long";
  if (!UUID.test(id)) return "not_found";
  const result = await inTx(pool, async (client) => {
    const { rows: [q] } = await client.query(
      "update questions set status = 'answered', answer = $3, answered_at = $4, updated_at = $4 where id = $1 and host_id = $2 and status = 'open' returning id, host_id, guest_email::text as guest_email",
      [id, hostId, text, now]);
    if (!q) return (await client.query("select 1 from questions where id = $1 and host_id = $2", [id, hostId])).rows.length ? "not_open" as const : "not_found" as const;
    await notify(client, q, "question_answer_guest", q.guest_email, now);
    return "answered" as const;
  });
  if (result === "answered") kickJobs();
  return result;
}

/** The host turns a question down: a paid one is refunded in full, and the guest is told either way. */
export async function declineQuestion(pool: pg.Pool, hostId: string, id: string, now: Date): Promise<"declined" | QuestionActionRefused> {
  if (!UUID.test(id)) return "not_found";
  const result = await inTx(pool, async (client) => {
    const { rows: [q] } = await client.query(
      `update questions set status = case when price_minor > 0 then 'refund_pending' else 'declined' end, declined_at = $3, updated_at = $3
       where id = $1 and host_id = $2 and status = 'open' returning id, host_id, guest_email::text as guest_email`, [id, hostId, now]);
    if (!q) return (await client.query("select 1 from questions where id = $1 and host_id = $2", [id, hostId])).rows.length ? "not_open" as const : "not_found" as const;
    await notify(client, q, "question_declined_guest", q.guest_email, now);
    return "declined" as const;
  });
  if (result === "declined") kickJobs();
  return result;
}

/** How long a question may stay open past its due date before it is closed for the host. */
export const EXPIRY_GRACE_MS = DAY;
/** How long before its due date the host is reminded to answer. */
export const REMINDER_LEAD_MS = DAY;

export interface QuestionDeadlineResult { reminded: number; expired: number }

/**
 * The job runner's deadline pass (B21): reminds the host a day before an open question is due, and closes a question
 * still open a day after it was due. A paid one goes to refund_pending, so the refund pass refunds it in full on the
 * account that took the money; a free one is declined. The guest and the host are both told. Each row is claimed with
 * a conditional update, so two runners never remind or close the same question twice.
 */
export async function runQuestionDeadlines(pool: pg.Pool, now: Date, limit = 50): Promise<QuestionDeadlineResult> {
  const result: QuestionDeadlineResult = { reminded: 0, expired: 0 };
  await inTx(pool, async (client) => {
    const { rows } = await client.query(
      `with due as (
         select id from questions
         where status = 'open' and due_at is not null and due_at <= $1::timestamptz - $3 * interval '1 millisecond'
         order by due_at limit $2 for update skip locked)
       update questions q set status = case when q.price_minor > 0 then 'refund_pending' else 'declined' end,
         declined_at = $1, expired_at = $1, updated_at = $1
       from due where q.id = due.id
       returning q.id, q.host_id, q.guest_email::text as guest_email, (select email::text from users where id = q.host_id) as host_email`,
      [now, limit, EXPIRY_GRACE_MS]);
    for (const q of rows) {
      await notify(client, q, "question_expired_guest", q.guest_email, now);
      await notify(client, q, "question_expired_host", q.host_email, now);
    }
    result.expired = rows.length;
  });
  await inTx(pool, async (client) => {
    const { rows } = await client.query(
      `with due as (
         select id from questions
         where status = 'open' and host_reminded_at is null and due_at is not null
           and due_at > $1::timestamptz and due_at <= $1::timestamptz + $3 * interval '1 millisecond'
         order by due_at limit $2 for update skip locked)
       update questions q set host_reminded_at = $1, updated_at = $1
       from due where q.id = due.id
       returning q.id, q.host_id, (select email::text from users where id = q.host_id) as host_email`,
      [now, limit, REMINDER_LEAD_MS]);
    for (const q of rows) await notify(client, q, "question_due_host", q.host_email, now);
    result.reminded = rows.length;
  });
  return result;
}
