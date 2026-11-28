import { createHash } from "node:crypto";
import type pg from "pg";
import { BillingApiError } from "../billing/providers";
import { kickJobs } from "../jobs/kick";
import { authForPayment, type PaymentCheckDeps } from "../payments/booking-payments";
import type { HostRazorpayAuth } from "../payments/host-razorpay";
import { collectionTerms } from "../payments/platform";
import type { RazorpayOrders, RazorpayPayment } from "../payments/razorpay-orders";

// Digital products (B20, like Topmate's). A host sells a file (kept in the database, like profile photos) or a link
// shown after payment. Guests buy at /<slug>/shop/<product>, pay the host's Razorpay (or Hourhand's, B18) or get it
// free, and download from their private page /d/<token>. A host can refund a paid order; the job runner refunds it on
// the account that took the money, and the download stops at once.

type Db = Pick<pg.Pool, "query">;
const DAY = 86_400_000;
const CURRENCY = "INR";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{48}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const MAX_PRICE_MINOR = 10_000_000;
export const MAX_PRODUCTS = 20;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_HOST_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_DOWNLOADS = 20;

export type Delivery = "file" | "link";
export interface Product {
  id: string; slug: string; title: string; description: string | null; priceMinor: number; currency: "INR"; delivery: Delivery;
  linkUrl: string | null; active: boolean; file: { filename: string; sizeBytes: number } | null;
}
export type OrderStatus = "pending" | "paid" | "failed" | "refund_pending" | "refunded";
export interface Order {
  id: string; productId: string; productTitle: string; buyerName: string; buyerEmail: string; priceMinor: number; currency: "INR";
  status: OrderStatus; paidAt: Date | null; downloadCount: number; createdAt: Date;
}

export class ProductInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Invalid product input");
    this.name = "ProductInputError";
  }
}

const PRODUCT_COLUMNS = `p.id, p.slug, p.title, p.description, p.price_minor, p.delivery, p.link_url, p.active,
  f.filename as file_name, f.size_bytes as file_size`;
const toProduct = (r: Record<string, unknown>): Product => ({
  id: r.id as string, slug: r.slug as string, title: r.title as string, description: (r.description as string | null) ?? null,
  priceMinor: r.price_minor as number, currency: "INR", delivery: r.delivery as Delivery, linkUrl: (r.link_url as string | null) ?? null,
  active: r.active as boolean, file: r.file_name ? { filename: r.file_name as string, sizeBytes: r.file_size as number } : null,
});

export async function listProducts(db: Db, hostId: string): Promise<Product[]> {
  const { rows } = await db.query(
    `select ${PRODUCT_COLUMNS} from digital_products p left join product_files f on f.product_id = p.id
     where p.host_id = $1 order by p.created_at`, [hostId]);
  return rows.map(toProduct);
}

export async function getProduct(db: Db, hostId: string, id: string): Promise<Product | null> {
  if (!UUID.test(id)) return null;
  const { rows: [r] } = await db.query(
    `select ${PRODUCT_COLUMNS} from digital_products p left join product_files f on f.product_id = p.id
     where p.host_id = $1 and p.id = $2`, [hostId, id]);
  return r ? toProduct(r) : null;
}

export interface ProductInput {
  id?: string; slug: string; title: string; description: string; priceMinor: number; delivery: string; linkUrl: string; active: boolean;
}

/**
 * Creates or updates one of the host's products. canCharge says whether the host may set a price (a paid plan and an
 * account that can take the money, checked by the caller). A product goes live only once it has something to deliver.
 */
export async function saveProduct(db: Db, hostId: string, input: ProductInput, canCharge: boolean): Promise<Product> {
  const fields: Record<string, string> = {};
  const slug = input.slug.trim().toLowerCase(), title = input.title.trim(), description = input.description.trim(), link = input.linkUrl.trim();
  if (!SLUG.test(slug)) fields.slug = "Use 1 to 60 lowercase letters, numbers and dashes.";
  if (title.length < 1 || title.length > 120) fields.title = "Enter a title (up to 120 characters).";
  if (description.length > 2000) fields.description = "Keep it to 2,000 characters.";
  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0 || input.priceMinor > MAX_PRICE_MINOR) fields.price = "Enter a price from ₹0 (free) to ₹1,00,000.";
  else if (input.priceMinor > 0 && input.priceMinor < 100) fields.price = "A paid product costs at least ₹1.";
  else if (input.priceMinor > 0 && !canCharge) fields.price = "Charging needs a paid plan and a connected Razorpay account.";
  const delivery = input.delivery === "link" ? "link" : input.delivery === "file" ? "file" : null;
  if (!delivery) fields.delivery = "Pick a file or a link.";
  if (link && (!/^https:\/\/[^\s]+$/.test(link) || link.length > 500)) fields.linkUrl = "Enter an https:// link (up to 500 characters).";
  if (input.id !== undefined && !UUID.test(input.id)) fields.id = "Not found.";
  if (Object.keys(fields).length) throw new ProductInputError(fields);

  const existing = input.id ? await getProduct(db, hostId, input.id) : null;
  if (input.id && !existing) throw new ProductInputError({ id: "Not found." });
  if (input.active) {
    if (delivery === "file" && !existing?.file) fields.active = "Upload the file before you turn it on.";
    if (delivery === "link" && !link) fields.active = "Add the link before you turn it on.";
  }
  if (!existing) {
    const { rows: [{ n }] } = await db.query("select count(*)::int as n from digital_products where host_id = $1", [hostId]);
    if (n >= MAX_PRODUCTS) fields.limit = `You can have up to ${MAX_PRODUCTS} products.`;
  }
  if (Object.keys(fields).length) throw new ProductInputError(fields);

  const values = [hostId, slug, title, description || null, input.priceMinor, delivery, link || null, input.active];
  try {
    const { rows: [r] } = existing
      ? await db.query(
        `update digital_products set slug = $2, title = $3, description = $4, price_minor = $5, delivery = $6, link_url = $7, active = $8, updated_at = now()
         where host_id = $1 and id = $9 returning id`, [...values, existing.id])
      : await db.query(
        `insert into digital_products (host_id, slug, title, description, price_minor, delivery, link_url, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, values);
    return (await getProduct(db, hostId, r.id)) as Product;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ProductInputError({ slug: "Another of your products already uses this link." });
    throw error;
  }
}

const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf", epub: "application/epub+zip", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  mp3: "audio/mpeg", txt: "text/plain", csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const starts = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** The stored type of an upload, from an allowed extension whose content matches it; null when it isn't allowed. */
export function fileTypeFor(filename: string, data: Uint8Array): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const mime = FILE_TYPES[ext];
  if (!mime || data.length === 0) return null;
  if (ext === "pdf" && !starts(data, [0x25, 0x50, 0x44, 0x46])) return null;
  if (["zip", "epub", "docx", "xlsx", "pptx"].includes(ext) && !starts(data, ZIP)) return null;
  if (ext === "png" && !starts(data, [0x89, 0x50, 0x4e, 0x47])) return null;
  if ((ext === "jpg" || ext === "jpeg") && !starts(data, [0xff, 0xd8, 0xff])) return null;
  if (ext === "mp3" && !(starts(data, [0x49, 0x44, 0x33]) || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0))) return null;
  return mime;
}

export type FileRefused = "not_found" | "too_big" | "bad_type" | "host_full";

/** Stores (or replaces) a product's file, for the host who owns the product, within the size limits. */
export async function saveProductFile(db: Db, hostId: string, productId: string, file: { filename: string; data: Uint8Array }): Promise<"saved" | FileRefused> {
  if (!UUID.test(productId)) return "not_found";
  const { rows: [owned] } = await db.query("select 1 from digital_products where id = $1 and host_id = $2", [productId, hostId]);
  if (!owned) return "not_found";
  if (file.data.length > MAX_FILE_BYTES) return "too_big";
  const mime = fileTypeFor(file.filename, file.data);
  if (!mime) return "bad_type";
  const { rows: [{ used }] } = await db.query(
    `select coalesce(sum(f.size_bytes), 0)::bigint as used from product_files f join digital_products p on p.id = f.product_id
     where p.host_id = $1 and f.product_id <> $2`, [hostId, productId]);
  if (Number(used) + file.data.length > MAX_HOST_FILE_BYTES) return "host_full";
  const filename = file.filename.replace(/[\\/\r\n"]/g, "_").slice(-200);
  const sha = createHash("sha256").update(file.data).digest("hex");
  await db.query(
    `insert into product_files (product_id, filename, mime, size_bytes, data, sha256) values ($1, $2, $3, $4, $5, $6)
     on conflict (product_id) do update set filename = excluded.filename, mime = excluded.mime, size_bytes = excluded.size_bytes,
       data = excluded.data, sha256 = excluded.sha256, updated_at = now()`,
    [productId, filename, mime, file.data.length, Buffer.from(file.data), sha]);
  return "saved";
}

export interface PublicProduct { host: { id: string; name: string; slug: string }; product: Product }

const PUBLIC_WHERE = `u.slug = $1 and p.active and u.deleted_at is null and u.review_status = 'approved'
  and ((p.delivery = 'file' and f.product_id is not null) or (p.delivery = 'link' and p.link_url is not null))`;

/** A host's live products as guests see them (only for public hosts, and only products with something to deliver). */
export async function publicProducts(db: Db, slug: string): Promise<{ host: { id: string; name: string; slug: string }; products: Product[] } | null> {
  const { rows } = await db.query(
    `select ${PRODUCT_COLUMNS}, u.id as host_id, u.name as host_name, u.slug::text as host_slug
     from digital_products p join users u on u.id = p.host_id left join product_files f on f.product_id = p.id
     where ${PUBLIC_WHERE} order by p.created_at`, [slug]);
  if (!rows.length) return null;
  return { host: { id: rows[0].host_id, name: rows[0].host_name, slug: rows[0].host_slug }, products: rows.map(toProduct) };
}

export async function publicProduct(db: Db, slug: string, productSlug: string): Promise<PublicProduct | null> {
  if (!SLUG.test(productSlug)) return null;
  const { rows: [r] } = await db.query(
    `select ${PRODUCT_COLUMNS}, u.id as host_id, u.name as host_name, u.slug::text as host_slug
     from digital_products p join users u on u.id = p.host_id left join product_files f on f.product_id = p.id
     where ${PUBLIC_WHERE} and p.slug = $2`, [slug, productSlug]);
  return r ? { host: { id: r.host_id, name: r.host_name, slug: r.host_slug }, product: toProduct(r) } : null;
}

type MailKind = "product_sale_host" | "product_receipt_buyer" | "product_refund_buyer";

/** Queues an email for an order (the worker renders it from the order's current state). */
async function notify(db: Db, o: { id: string; host_id: string }, kind: MailKind, to: string, now: Date) {
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     values (null, $1, 'email', $2, $3, $4, $5) on conflict (dedupe_key) do nothing`, [o.host_id, kind, to, now, `product:${o.id}:${kind}`]);
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

export interface OrderCheckout { orderId: string; keyId: string; amount: number; currency: string }
export class OrderStartError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "OrderStartError";
  }
}

/** Marks an order paid (free, or just paid): the buyer gets their link and the host is told. */
async function markPaid(client: Db, id: string, now: Date, paid: { paymentId: string } | null): Promise<boolean> {
  const { rows: [o] } = await client.query(
    `update product_orders o set status = 'paid', paid_at = $2, updated_at = $2, provider_payment_id = coalesce($3, o.provider_payment_id), last_error = null
     where o.id = $1 and o.status in ('pending', 'failed')
     returning o.id, o.host_id, o.buyer_email::text as buyer_email, (select email::text from users where id = o.host_id) as host_email`,
    [id, now, paid?.paymentId ?? null]);
  if (!o) return false;
  await notify(client, o, "product_receipt_buyer", o.buyer_email, now);
  await notify(client, o, "product_sale_host", o.host_email, now);
  return true;
}

/**
 * Starts an order: validated, stored once per request key, then paid at once (free) or given a Razorpay order on the
 * account that collects for the host. A repeat of the request returns the same order.
 */
export async function startOrder(
  deps: { pool: pg.Pool; auth: HostRazorpayAuth | null; orders: RazorpayOrders | null }, found: PublicProduct, input: unknown, now: Date,
): Promise<{ token: string; status: OrderStatus; payment: OrderCheckout | null }> {
  const body = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const name = str("name"), email = str("email"), key = str("idempotencyKey");
  const fields: Record<string, string> = {};
  if (name.length < 1 || name.length > 100) fields.name = "Enter your name (up to 100 characters).";
  if (!EMAIL.test(email) || email.length > 254) fields.email = "Enter a valid email address.";
  if (key.length < 8 || key.length > 100) fields.idempotencyKey = "Missing request key.";
  if (Object.keys(fields).length) throw new ProductInputError(fields);

  const { pool, auth, orders } = deps;
  const price = found.product.priceMinor;
  if (price > 0 && (!auth || !orders)) throw new OrderStartError("payments_unavailable", false);
  await pool.query(
    `insert into product_orders (product_id, host_id, idempotency_key, buyer_name, buyer_email, price_minor, currency, status, provider)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) on conflict (product_id, idempotency_key) do nothing`,
    [found.product.id, found.host.id, key, name, email, price, CURRENCY, price > 0 ? "razorpay" : null]);
  const { rows: [row] } = await pool.query(
    "select id, token, status, price_minor, provider_order_id from product_orders where product_id = $1 and idempotency_key = $2", [found.product.id, key]);

  if (row.price_minor === 0) {
    if (row.status === "pending") {
      await inTx(pool, (client) => markPaid(client, row.id, now, null));
      kickJobs();
      return { token: row.token, status: "paid", payment: null };
    }
    return { token: row.token, status: row.status, payment: null };
  }
  if (row.status !== "pending") return { token: row.token, status: row.status, payment: null };
  const checkout = (orderId: string): OrderCheckout => ({ orderId, keyId: auth!.keyId, amount: row.price_minor, currency: CURRENCY });
  if (row.provider_order_id) return { token: row.token, status: "pending", payment: checkout(row.provider_order_id) };

  const orderId = await inTx(pool, async (client) => {
    const { rows: [locked] } = await client.query("select provider_order_id from product_orders where id = $1 for update", [row.id]);
    if (locked.provider_order_id) return locked.provider_order_id as string;
    const terms = collectionTerms(auth!, row.price_minor, CURRENCY);
    let order;
    try {
      order = await orders!.createOrder({ amount: row.price_minor, currency: CURRENCY, receipt: `p-${row.id}`, notes: { product_order_id: row.id }, transfers: terms.transfers });
    } catch (error) {
      throw new OrderStartError(`Payment could not start: ${(error as Error).message}`, error instanceof BillingApiError && error.retryable);
    }
    await client.query(
      "update product_orders set provider_order_id = $2, collected_via = $3, commission_minor = $4, transfer_account = $5, updated_at = now() where id = $1",
      [row.id, order.id, terms.collectedVia, terms.commissionMinor, terms.transferAccount]);
    return order.id;
  });
  return { token: row.token, status: "pending", payment: checkout(orderId) };
}

export async function applyOrderPayment(pool: pg.Pool, id: string, paymentId: string, now: Date): Promise<"paid" | "already"> {
  const paid = await inTx(pool, (client) => markPaid(client, id, now, { paymentId }));
  if (paid) kickJobs();
  return paid ? "paid" : "already";
}

export type OrderVerifyReason = "no_payment" | "bad_signature" | "mismatch" | "not_paid";
export class OrderVerifyError extends Error {
  constructor(readonly reason: OrderVerifyReason) {
    super(`Order payment could not be verified: ${reason}`);
    this.name = "OrderVerifyError";
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

/** The account that took (or will take) an order's payment, from its own row. */
export async function orderPaymentRow(db: Db, token: string): Promise<{ id: string; host_id: string; collected_via: string; provider_order_id: string | null; price_minor: number; currency: string } | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query("select id, host_id, collected_via, provider_order_id, price_minor, currency from product_orders where token = $1", [token]);
  return r ?? null;
}

/** Confirms an order from what Razorpay Checkout handed the browser; amounts come from our row, never the client. */
export async function confirmOrder(
  deps: { pool: pg.Pool; auth: HostRazorpayAuth; orders: RazorpayOrders }, input: { token: string; paymentId: string; signature: string }, now: Date,
): Promise<"paid" | "already"> {
  const row = await orderPaymentRow(deps.pool, input.token);
  if (!row?.provider_order_id) throw new OrderVerifyError("no_payment");
  if (!deps.auth.verifyPaymentSignature(row.provider_order_id, input.paymentId, input.signature)) throw new OrderVerifyError("bad_signature");
  let p = await deps.orders.getPayment(input.paymentId);
  if (p.orderId !== row.provider_order_id || p.amount !== row.price_minor || p.currency !== row.currency) throw new OrderVerifyError("mismatch");
  if (p.status === "authorized") p = await captureOnce(deps.orders, p.id, row.price_minor, row.currency);
  if (p.status !== "captured") throw new OrderVerifyError("not_paid");
  return applyOrderPayment(deps.pool, row.id, p.id, now);
}

const RECHECK_MS = 60_000;
export interface ProductJobResult { checked: number; paid: number; failed: number; refunded: number; errors: number }

/** The job runner's pass over orders: settles pending payments with Razorpay (failing after a day) and makes refunds. */
export async function runProductJobs(deps: PaymentCheckDeps & { pool: pg.Pool }, now: Date, limit = 20): Promise<ProductJobResult> {
  const { pool } = deps;
  const { rows } = await pool.query(
    `with due as (
       select id from product_orders
       where provider = 'razorpay' and status in ('pending', 'refund_pending') and provider_order_id is not null
         and created_at < $1::timestamptz - $3 * interval '1 millisecond'
         and (checked_at is null or checked_at < $1::timestamptz - $3 * interval '1 millisecond')
       order by checked_at nulls first, created_at limit $2 for update skip locked)
     update product_orders o set checked_at = $1 from due where o.id = due.id
     returning o.id, o.host_id, o.status, o.collected_via, o.transfer_account, o.provider_order_id, o.provider_payment_id, o.price_minor, o.currency, o.created_at`,
    [now, limit, RECHECK_MS]);
  const result: ProductJobResult = { checked: rows.length, paid: 0, failed: 0, refunded: 0, errors: 0 };
  for (const r of rows) {
    try {
      const auth = await authForPayment(deps, r);
      if (!auth) {
        await pool.query("update product_orders set last_error = 'Razorpay disconnected', updated_at = $2 where id = $1", [r.id, now]);
        continue;
      }
      const orders = deps.ordersFor(auth);
      if (r.status === "refund_pending") {
        // Never refund twice: a refund that went through before we could record it is found and recorded.
        const earlier = (await orders.listRefunds(r.provider_payment_id)).filter((x) => x.status !== "failed");
        const refund = earlier[0] ?? await orders.refund(r.provider_payment_id, { receipt: `p-${r.id}`, notes: { product_order_id: r.id }, ...(r.transfer_account ? { reverseAll: true } : {}) });
        await pool.query("update product_orders set status = 'refunded', refund_id = $2, last_error = null, updated_at = $3 where id = $1 and status = 'refund_pending'", [r.id, refund.id, now]);
        result.refunded += 1;
        continue;
      }
      const items = await orders.orderPayments(r.provider_order_id);
      const ours = (p: RazorpayPayment) => p.amount === r.price_minor && p.currency === r.currency;
      const captured = items.find((p) => p.status === "captured" && ours(p));
      const authorized = items.find((p) => p.status === "authorized" && ours(p));
      const paid = captured ?? (authorized ? await captureOnce(orders, authorized.id, r.price_minor, r.currency) : null);
      if (paid?.status === "captured") {
        if ((await applyOrderPayment(pool, r.id, paid.id, now)) === "paid") result.paid += 1;
      } else if (now.getTime() - new Date(r.created_at).getTime() > DAY) {
        await pool.query("update product_orders set status = 'failed', updated_at = $2 where id = $1 and status = 'pending'", [r.id, now]);
        result.failed += 1;
      }
    } catch (error) {
      result.errors += 1;
      await pool.query("update product_orders set last_error = $2, updated_at = $3 where id = $1", [r.id, ((error as Error).message ?? String(error)).slice(0, 500), now]).catch(() => undefined);
    }
  }
  return result;
}

const ORDER_COLUMNS = `o.id, o.product_id, p.title as product_title, o.buyer_name, o.buyer_email::text as buyer_email, o.price_minor, o.status,
  o.paid_at, o.download_count, o.created_at`;
const toOrder = (r: Record<string, unknown>): Order => ({
  id: r.id as string, productId: r.product_id as string, productTitle: r.product_title as string, buyerName: r.buyer_name as string,
  buyerEmail: r.buyer_email as string, priceMinor: r.price_minor as number, currency: "INR", status: r.status as OrderStatus,
  paidAt: (r.paid_at as Date | null) ?? null, downloadCount: r.download_count as number, createdAt: r.created_at as Date,
});

/** A host's orders, newest first: only ones that were paid (not abandoned checkouts). */
export async function listOrders(db: Db, hostId: string, limit = 200): Promise<Order[]> {
  const { rows } = await db.query(
    `select ${ORDER_COLUMNS} from product_orders o join digital_products p on p.id = o.product_id
     where o.host_id = $1 and o.status in ('paid', 'refund_pending', 'refunded') order by o.created_at desc limit $2`, [hostId, limit]);
  return rows.map(toOrder);
}

export interface BuyerView {
  status: OrderStatus; productTitle: string; delivery: Delivery; linkUrl: string | null; hasFile: boolean; filename: string | null;
  downloadsLeft: number; hostName: string; hostSlug: string; buyerName: string;
}

/** The buyer's own view of their order, by its private token. The link is only shown once paid. */
export async function orderByToken(db: Db, token: string): Promise<BuyerView | null> {
  if (!TOKEN.test(token)) return null;
  const { rows: [r] } = await db.query(
    `select o.status, o.buyer_name, o.download_count, p.title, p.delivery, p.link_url, f.filename, u.name as host_name, u.slug::text as host_slug
     from product_orders o join digital_products p on p.id = o.product_id join users u on u.id = o.host_id
     left join product_files f on f.product_id = p.id where o.token = $1`, [token]);
  if (!r) return null;
  const paid = r.status === "paid";
  return {
    status: r.status, productTitle: r.title, delivery: r.delivery, linkUrl: paid && r.delivery === "link" ? r.link_url : null,
    hasFile: Boolean(r.filename), filename: r.filename ?? null, downloadsLeft: Math.max(0, MAX_DOWNLOADS - r.download_count),
    hostName: r.host_name, hostSlug: r.host_slug, buyerName: r.buyer_name,
  };
}

export type DownloadRefused = "not_found" | "not_paid" | "limit";

/** Hands out the file for a paid order, counting the download; refused once the order has used its downloads. */
export async function takeDownload(db: Db, token: string): Promise<{ filename: string; mime: string; data: Buffer } | DownloadRefused> {
  if (!TOKEN.test(token)) return "not_found";
  const { rows: [r] } = await db.query(
    `update product_orders o set download_count = download_count + 1, updated_at = now()
     from digital_products p join product_files f on f.product_id = p.id
     where o.token = $1 and p.id = o.product_id and p.delivery = 'file' and o.status = 'paid' and o.download_count < $2
     returning f.filename, f.mime, f.data`, [token, MAX_DOWNLOADS]);
  if (r) return { filename: r.filename, mime: r.mime, data: r.data };
  const { rows: [o] } = await db.query(
    `select o.status, o.download_count, p.delivery, (f.product_id is not null) as has_file from product_orders o
     join digital_products p on p.id = o.product_id left join product_files f on f.product_id = p.id where o.token = $1`, [token]);
  if (!o || o.delivery !== "file" || !o.has_file) return "not_found";
  if (o.status !== "paid") return "not_paid";
  return "limit";
}

export type RefundRefused = "not_found" | "not_refundable";

/** The host refunds a paid order in full: the download stops at once and the job runner returns the money. */
export async function refundOrder(pool: pg.Pool, hostId: string, id: string, now: Date): Promise<"refunding" | RefundRefused> {
  if (!UUID.test(id)) return "not_found";
  const result = await inTx(pool, async (client) => {
    const { rows: [o] } = await client.query(
      `update product_orders set status = 'refund_pending', refunded_at = $3, updated_at = $3
       where id = $1 and host_id = $2 and status = 'paid' and price_minor > 0 returning id, host_id, buyer_email::text as buyer_email`, [id, hostId, now]);
    if (!o) return (await client.query("select 1 from product_orders where id = $1 and host_id = $2", [id, hostId])).rows.length ? "not_refundable" as const : "not_found" as const;
    await notify(client, o, "product_refund_buyer", o.buyer_email, now);
    return "refunding" as const;
  });
  if (result === "refunding") kickJobs();
  return result;
}
