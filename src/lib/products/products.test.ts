// B20: digital products, against real Postgres and a fake Razorpay (only with TEST_DATABASE_URL; uses its own database
// <name>_p, dropped and recreated on every run).
import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { User } from "../data/types";
import { keyPairAuth, type HostRazorpayAuth } from "../payments/host-razorpay";
import { razorpayOrders } from "../payments/razorpay-orders";
import {
  confirmOrder, fileTypeFor, listOrders, MAX_DOWNLOADS, orderByToken, publicProduct, publicProducts, refundOrder, runProductJobs,
  saveProduct, saveProductFile, startOrder, takeDownload, type ProductInput,
} from "./products";
import { handleStartOrder } from "./handlers";
import { renderProductMail } from "../mail/templates";
import { businessReport } from "../reports/report";
import { profileOfferings } from "../profile-offerings";
import { saveOffer } from "../questions/questions";

const BASE = process.env.TEST_DATABASE_URL;
const auth = keyPairAuth("rzp_test_ProductHost1", "p-secret");
const sign = (order: string, payment: string) => createHmac("sha256", "p-secret").update(`${order}|${payment}`).digest("hex");
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

function fakeRazorpay(a: HostRazorpayAuth = auth) {
  const state = { orders: [] as Record<string, unknown>[], refunds: [] as Record<string, unknown>[], payments: new Map<string, Record<string, unknown>>() };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (method === "POST" && path === "/v1/orders") {
      const body = JSON.parse(String(init.body));
      state.orders.push(body);
      return json({ id: `order_p${state.orders.length}${Math.random().toString(36).slice(2, 7)}`, amount: body.amount, currency: body.currency, status: "created" });
    }
    const o = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path);
    if (o) return json({ items: [...state.payments.values()].filter((p) => p.order_id === decodeURIComponent(o[1])) });
    const rf = /^\/v1\/payments\/([^/]+)\/(refund|refunds)$/.exec(path);
    if (rf) {
      if (rf[2] === "refunds") return json({ items: state.refunds.map((r, i) => ({ id: `rfnd_p${i + 1}`, status: "processed", amount: 0, ...r })) });
      state.refunds.push(JSON.parse(String(init.body)));
      return json({ id: `rfnd_p${state.refunds.length}`, status: "pending", amount: 0 });
    }
    const m = /^\/v1\/payments\/([^/]+)(\/capture)?$/.exec(path);
    const p = m && state.payments.get(decodeURIComponent(m[1]));
    if (!p) return json({ error: { code: "BAD_REQUEST_ERROR", description: "no such payment" } }, 400);
    if (m[2]) p.status = "captured";
    return json(p);
  }) as unknown as typeof fetch;
  return { state, orders: razorpayOrders(a, { baseUrl: "https://rp.fake", fetchImpl }) };
}

describe.skipIf(!BASE)("digital products (Postgres)", () => {
  let pool: pg.Pool;
  let priya: User;
  let arun: User;
  let n = 0;
  const buy = (o: Record<string, unknown> = {}) => ({ name: "Asha", email: "asha@example.in", idempotencyKey: `p-${n++}-${Math.random()}`, ...o });
  const product = (o: Partial<ProductInput> = {}): ProductInput => ({ slug: "guide", title: "Interview guide", description: "", priceMinor: 0, delivery: "file", linkUrl: "", active: false, ...o });
  const notes = async (kind: string) => (await pool.query("select recipient, dedupe_key from notifications where kind = $1 order by created_at", [kind])).rows;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_p`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const root = new URL(BASE!);
    root.pathname = "/postgres";
    const c = new pg.Client({ connectionString: root.toString() });
    await c.connect();
    try {
      await c.query(`drop database if exists ${name} with (force)`);
      await c.query(`create database ${name}`);
    } finally {
      await c.end();
    }
    await migrate(u.toString());
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    const store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("accepts only allowed file types whose content matches", () => {
    expect(fileTypeFor("guide.pdf", PDF)).toBe("application/pdf");
    expect(fileTypeFor("guide.pdf", new Uint8Array([0x3c, 0x68, 0x74]))).toBeNull();
    expect(fileTypeFor("run.exe", PDF)).toBeNull();
    expect(fileTypeFor("notes.txt", new TextEncoder().encode("hello"))).toBe("text/plain");
  });

  it("goes live only with something to deliver, and only for public hosts", async () => {
    await expect(saveProduct(pool, priya.id, product({ priceMinor: 9_900 }), false)).rejects.toMatchObject({ fields: { price: expect.any(String) } });
    await expect(saveProduct(pool, priya.id, product({ active: true }), true)).rejects.toMatchObject({ fields: { active: expect.any(String) } });
    const p = await saveProduct(pool, priya.id, product(), true);
    expect(await publicProduct(pool, "priya", "guide")).toBeNull();
    expect(await saveProductFile(pool, arun.id, p.id, { filename: "guide.pdf", data: PDF })).toBe("not_found");
    expect(await saveProductFile(pool, priya.id, p.id, { filename: "guide.exe", data: PDF })).toBe("bad_type");
    expect(await saveProductFile(pool, priya.id, p.id, { filename: "guide.pdf", data: PDF })).toBe("saved");
    await saveProduct(pool, priya.id, product({ id: p.id, active: true }), true);
    expect(await publicProduct(pool, "priya", "guide")).toMatchObject({ host: { id: priya.id }, product: { title: "Interview guide", file: { filename: "guide.pdf" } } });
    expect((await publicProducts(pool, "priya"))?.products).toHaveLength(1);
    await expect(saveProduct(pool, priya.id, product({ title: "Copy" }), true)).rejects.toMatchObject({ fields: { slug: expect.any(String) } });
    await expect(saveProduct(pool, arun.id, product({ id: p.id, title: "Mine now" }), true)).rejects.toMatchObject({ fields: { id: expect.any(String) } });
    await pool.query("update users set review_status = 'suspended' where id = $1", [priya.id]);
    expect(await publicProduct(pool, "priya", "guide")).toBeNull();
    await pool.query("update users set review_status = 'approved' where id = $1", [priya.id]);
  });

  it("gives a free product at once, once per request, and counts downloads up to the limit", async () => {
    const found = (await publicProduct(pool, "priya", "guide"))!;
    const input = buy();
    await expect(startOrder({ pool, auth: null, orders: null }, found, { ...input, email: "nope" }, new Date())).rejects.toMatchObject({ fields: { email: expect.any(String) } });
    const a = await startOrder({ pool, auth: null, orders: null }, found, input, new Date());
    const b = await startOrder({ pool, auth: null, orders: null }, found, input, new Date());
    expect(a).toMatchObject({ status: "paid", payment: null });
    expect(b.token).toBe(a.token);
    expect(await orderByToken(pool, a.token)).toMatchObject({ status: "paid", productTitle: "Interview guide", hasFile: true, downloadsLeft: MAX_DOWNLOADS });
    const [order] = await listOrders(pool, priya.id);
    expect(await notes("product_receipt_buyer")).toEqual([{ recipient: "asha@example.in", dedupe_key: `product:${order.id}:product_receipt_buyer` }]);
    expect(await notes("product_sale_host")).toEqual([{ recipient: priya.email, dedupe_key: `product:${order.id}:product_sale_host` }]);
    const file = await takeDownload(pool, a.token);
    expect(file).toMatchObject({ filename: "guide.pdf", mime: "application/pdf" });
    expect(new Uint8Array((file as { data: Buffer }).data)).toEqual(PDF);
    await pool.query("update product_orders set download_count = $2 where token = $1", [a.token, MAX_DOWNLOADS]);
    expect(await takeDownload(pool, a.token)).toBe("limit");
    expect(await takeDownload(pool, "0".repeat(48))).toBe("not_found");
    // A free order has nothing to refund.
    expect(await refundOrder(pool, priya.id, order.id, new Date())).toBe("not_refundable");
  });

  it("takes payment, opens the download only on a captured payment, and refunds the host's own order once", async () => {
    const p = await saveProduct(pool, priya.id, product({ slug: "templates", title: "Templates", priceMinor: 19_900, delivery: "link", linkUrl: "https://example.com/t", active: true }), true);
    const found = (await publicProduct(pool, "priya", p.slug))!;
    const fake = fakeRazorpay();
    const deps = { pool, auth, orders: fake.orders };
    const started = await startOrder(deps, found, buy(), new Date());
    expect(started).toMatchObject({ status: "pending", payment: { keyId: "rzp_test_ProductHost1", amount: 19_900 } });
    expect(fake.state.orders[0]).toMatchObject({ amount: 19_900, receipt: expect.stringMatching(/^p-/) });
    expect(await orderByToken(pool, started.token)).toMatchObject({ status: "pending", linkUrl: null });
    expect(await takeDownload(pool, started.token)).toBe("not_found"); // a link product has no file
    const orderId = started.payment!.orderId;
    fake.state.payments.set("pay_p1", { id: "pay_p1", order_id: orderId, amount: 19_900, currency: "INR", status: "created" });
    await expect(confirmOrder(deps, { token: started.token, paymentId: "pay_p1", signature: "bad" }, new Date())).rejects.toMatchObject({ reason: "bad_signature" });
    await expect(confirmOrder(deps, { token: started.token, paymentId: "pay_p1", signature: sign(orderId, "pay_p1") }, new Date())).rejects.toMatchObject({ reason: "not_paid" });
    fake.state.payments.get("pay_p1")!.status = "authorized";
    expect(await confirmOrder(deps, { token: started.token, paymentId: "pay_p1", signature: sign(orderId, "pay_p1") }, new Date())).toBe("paid");
    expect(await orderByToken(pool, started.token)).toMatchObject({ status: "paid", linkUrl: "https://example.com/t" });

    const order = (await listOrders(pool, priya.id)).find((o) => o.productId === p.id)!;
    expect(await refundOrder(pool, arun.id, order.id, new Date())).toBe("not_found");
    expect(await refundOrder(pool, priya.id, order.id, new Date())).toBe("refunding");
    expect(await refundOrder(pool, priya.id, order.id, new Date())).toBe("not_refundable");
    expect(await orderByToken(pool, started.token)).toMatchObject({ status: "refund_pending", linkUrl: null });
    const jobDeps = { pool, authFor: async () => auth, ordersFor: () => fake.orders, platformAuth: async () => null };
    const later = new Date(Date.now() + 120_000);
    expect(await runProductJobs(jobDeps, later)).toMatchObject({ refunded: 1, errors: 0 });
    expect(await runProductJobs(jobDeps, new Date(later.getTime() + 120_000))).toMatchObject({ checked: 0 });
    expect(fake.state.refunds).toHaveLength(1);
    expect(await orderByToken(pool, started.token)).toMatchObject({ status: "refunded" });
    expect(await notes("product_refund_buyer")).toHaveLength(1);
  });

  it("settles a paid checkout the buyer closed, and fails one never paid after a day", async () => {
    const found = (await publicProduct(pool, "priya", "templates"))!;
    const fake = fakeRazorpay();
    const deps = { pool, auth, orders: fake.orders };
    const closed = await startOrder(deps, found, buy(), new Date());
    const unpaid = await startOrder(deps, found, buy(), new Date());
    fake.state.payments.set("pay_p2", { id: "pay_p2", order_id: closed.payment!.orderId, amount: 19_900, currency: "INR", status: "captured" });
    const jobDeps = { pool, authFor: async () => auth, ordersFor: () => fake.orders, platformAuth: async () => null };
    expect(await runProductJobs(jobDeps, new Date(Date.now() + 120_000))).toMatchObject({ paid: 1, failed: 0 });
    expect((await orderByToken(pool, closed.token))?.status).toBe("paid");
    expect(await runProductJobs(jobDeps, new Date(Date.now() + 2 * 86_400_000))).toMatchObject({ failed: 1 });
    expect((await orderByToken(pool, unpaid.token))?.status).toBe("failed");
  });
  it("tells the host's webhooks about a sale, once, and only the endpoints that asked for it", async () => {
    const add = async (events: string[]) => (await pool.query(
      "insert into webhook_endpoints (user_id, url, secret_sealed, events) values ($1, 'https://hooks.example.com/x', '\\x00', $2) returning id", [priya.id, events])).rows[0].id as string;
    const wants = await add(["product.sold"]);
    const other = await add(["booking.created"]);
    const found = (await publicProduct(pool, "priya", "guide"))!;
    const input = buy({ name: "Kavya", email: "kavya@example.in" });
    const order = await startOrder({ pool, auth: null, orders: null }, found, input, new Date());
    await startOrder({ pool, auth: null, orders: null }, found, input, new Date());
    const { rows } = await pool.query("select endpoint_id, event, payload from webhook_deliveries where event = 'product.sold'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint_id: wants, event: "product.sold", payload: { event: "product.sold", data: {
      product_title: "Interview guide", buyer_name: "Kavya", buyer_email: "kavya@example.in", price_minor: 0, currency: "INR" } } });
    expect(rows[0].payload.data.order_id).toBe((await pool.query("select id from product_orders where token = $1", [order.token])).rows[0].id);
    expect((await pool.query("select 1 from webhook_deliveries where endpoint_id = $1", [other])).rows).toHaveLength(0);
    await pool.query("delete from webhook_endpoints where user_id = $1", [priya.id]);
  });

  it("refuses a paid product on the free plan and an unknown product", async () => {
    const fake = fakeRazorpay();
    const deps = { pool, authFor: async () => auth, ordersFor: () => fake.orders, planFor: async () => "free" as const };
    expect(await handleStartOrder(pool, deps, "priya", "templates", buy(), new Date())).toMatchObject({ status: 409 });
    expect(await handleStartOrder(pool, { ...deps, planFor: async () => "solo" as const }, "priya", "templates", buy(), new Date())).toMatchObject({ status: 200, body: { status: "pending" } });
    expect(await handleStartOrder(pool, deps, "priya", "nope", buy(), new Date())).toMatchObject({ status: 404 });
    expect(await handleStartOrder(pool, deps, "arun", "templates", buy(), new Date())).toMatchObject({ status: 404 });
  });
  it("renders the sale notice in the host's language and the buyer's receipt with their link", () => {
    const c = { hostName: "Priya", hostEmail: "p@x.in", buyerName: "Asha", buyerEmail: "a@x.in", productTitle: "Guide", priceMinor: 19_900, buyerUrl: "https://h.test/d/abc", dashboardUrl: "https://h.test/dashboard/products" };
    expect(renderProductMail("product_sale_host", { ...c, hostLocale: "ta" }).subject).toBe("புதிய விற்பனை: Guide");
    const receipt = renderProductMail("product_receipt_buyer", c);
    expect(receipt.text).toContain("https://h.test/d/abc");
    expect(renderProductMail("product_refund_buyer", c).text).toContain("no longer works");
  });
  it("counts product sales and refunds in the earnings report", async () => {
    const now = new Date();
    const period = { kind: "custom" as const, from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 3 * 86_400_000), first: "", last: "", timezone: "Asia/Kolkata", clamped: false };
    const r = (await businessReport(pool, priya.id, period, now))!;
    // Two paid orders of ₹199 (one later refunded); free orders aren't income.
    expect(r.currencies[0]).toMatchObject({ currency: "INR", productsMinor: 39_800, questionsMinor: 0, refundsMinor: 19_900 });
    expect(r.byEventType.find((l) => l.eventName === "Templates")).toMatchObject({ otherMinor: 19_900 });
  });

  it("lists a host's question offer and live products on their profile, and nothing they haven't switched on", async () => {
    expect(await profileOfferings(pool, "arun")).toEqual({ ask: null, products: [] });
    await saveOffer(pool, arun.id, { active: true, priceMinor: 49_900, responseDays: 3, intro: "" });
    // A draft product, and a live one with a link to deliver.
    await saveProduct(pool, arun.id, product({ slug: "draft", title: "Draft" }), true);
    await saveProduct(pool, arun.id, product({ slug: "notes", title: "Session notes", priceMinor: 9_900, delivery: "link", linkUrl: "https://example.com/n", active: true }), true);
    const o = await profileOfferings(pool, "arun");
    expect(o.ask).toEqual({ priceMinor: 49_900, responseDays: 3 });
    expect(o.products.map((x) => x.slug)).toEqual(["notes"]);
    await saveOffer(pool, arun.id, { active: false, priceMinor: 49_900, responseDays: 3, intro: "" });
    expect((await profileOfferings(pool, "arun")).ask).toBeNull();
    // A host who isn't approved shows nothing, like their ask and shop pages.
    await pool.query("update users set review_status = 'pending' where id = $1", [arun.id]);
    expect(await profileOfferings(pool, "arun")).toEqual({ ask: null, products: [] });
    await pool.query("update users set review_status = 'approved' where id = $1", [arun.id]);
  });
});
