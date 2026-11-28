// B19: Ask a question, against real Postgres and a fake Razorpay (only with TEST_DATABASE_URL; uses its own database
// <name>_q, dropped and recreated on every run).
import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { User } from "../data/types";
import { renderQuestionMail } from "../mail/templates";
import { keyPairAuth, type HostRazorpayAuth } from "../payments/host-razorpay";
import { razorpayOrders } from "../payments/razorpay-orders";
import { handleConfirmQuestion, handleStartQuestion } from "./handlers";
import { answerQuestion, applyQuestionPayment, declineQuestion, listQuestions, publicOffer, questionByToken, runQuestionDeadlines, runQuestionJobs, saveOffer, startQuestion } from "./questions";

const BASE = process.env.TEST_DATABASE_URL;
const auth = keyPairAuth("rzp_test_QuestionHost1", "q-secret");
const sign = (order: string, payment: string) => createHmac("sha256", "q-secret").update(`${order}|${payment}`).digest("hex");

function fakeRazorpay(a: HostRazorpayAuth = auth) {
  const state = { orders: [] as Record<string, unknown>[], refunds: [] as Record<string, unknown>[], payments: new Map<string, Record<string, unknown>>(), lastOrder: "" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (method === "POST" && path === "/v1/orders") {
      const body = JSON.parse(String(init.body));
      state.orders.push(body);
      state.lastOrder = `order_q${state.orders.length}${Math.random().toString(36).slice(2, 7)}`;
      return json({ id: state.lastOrder, amount: body.amount, currency: body.currency, status: "created" });
    }
    const o = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path);
    if (o) return json({ items: [...state.payments.values()].filter((p) => p.order_id === decodeURIComponent(o[1])) });
    const rf = /^\/v1\/payments\/([^/]+)\/(refund|refunds)$/.exec(path);
    if (rf) {
      if (rf[2] === "refunds") return json({ items: [] });
      state.refunds.push(JSON.parse(String(init.body)));
      return json({ id: `rfnd_q${state.refunds.length}`, status: "pending", amount: 0 });
    }
    const m = /^\/v1\/payments\/([^/]+)(\/capture)?$/.exec(path);
    const p = m && state.payments.get(decodeURIComponent(m[1]));
    if (!p) return json({ error: { code: "BAD_REQUEST_ERROR", description: "no such payment" } }, 400);
    if (m[2]) p.status = "captured";
    return json(p);
  }) as unknown as typeof fetch;
  return { state, orders: razorpayOrders(a, { baseUrl: "https://rp.fake", fetchImpl }) };
}

describe.skipIf(!BASE)("ask a question (Postgres)", () => {
  let pool: pg.Pool;
  let priya: User;
  let arun: User;
  let n = 0;
  const ask = (o: Record<string, unknown> = {}) => ({ name: "Asha", email: "asha@example.in", question: "How do I prepare for a product interview?", idempotencyKey: `q-${n++}-${Math.random()}`, ...o });
  const notes = async (kind: string) => (await pool.query("select recipient, dedupe_key from notifications where kind = $1 order by created_at", [kind])).rows;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_q`;
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

  it("shows the ask page only while the offer is on and the host's pages are public", async () => {
    expect(await publicOffer(pool, "priya")).toBeNull();
    await expect(saveOffer(pool, priya.id, { active: true, priceMinor: 50, responseDays: 3, intro: "" })).rejects.toMatchObject({ fields: { price: expect.any(String) } });
    await expect(saveOffer(pool, priya.id, { active: true, priceMinor: 0, responseDays: 30, intro: "" })).rejects.toMatchObject({ fields: { responseDays: expect.any(String) } });
    await saveOffer(pool, priya.id, { active: true, priceMinor: 0, responseDays: 2, intro: "Careers and interviews." });
    expect(await publicOffer(pool, "priya")).toMatchObject({ host: { id: priya.id }, offer: { priceMinor: 0, responseDays: 2, intro: "Careers and interviews." } });
    await pool.query("update users set review_status = 'suspended' where id = $1", [priya.id]);
    expect(await publicOffer(pool, "priya")).toBeNull();
    await pool.query("update users set review_status = 'approved' where id = $1", [priya.id]);
    expect((await handleStartQuestion(pool, null, "arun", ask(), new Date())).status).toBe(404);
  });

  it("opens a free question at once, once per request, and tells the host", async () => {
    const found = (await publicOffer(pool, "priya"))!;
    const now = new Date("2034-03-01T10:00:00Z");
    const input = ask();
    await expect(startQuestion({ pool, auth: null, orders: null }, found, { ...input, question: "" }, now)).rejects.toMatchObject({ fields: { question: expect.any(String) } });
    const a = await startQuestion({ pool, auth: null, orders: null }, found, input, now);
    const b = await startQuestion({ pool, auth: null, orders: null }, found, input, now);
    expect(a).toMatchObject({ status: "open", payment: null });
    expect(b.token).toBe(a.token);
    const q = (await questionByToken(pool, a.token))!;
    expect(q).toMatchObject({ status: "open", hostName: priya.name, question: input.question });
    expect(q.dueAt).toEqual(new Date("2034-03-03T10:00:00Z"));
    expect(await notes("question_host")).toEqual([{ recipient: priya.email, dedupe_key: `question:${q.id}:question_host` }]);
  });

  it("answers only the host's own open question, and emails the guest the answer", async () => {
    const [q] = await listQuestions(pool, priya.id);
    expect(await answerQuestion(pool, arun.id, q.id, "Not mine to answer.", new Date())).toBe("not_found");
    expect(await answerQuestion(pool, priya.id, q.id, "   ", new Date())).toBe("empty");
    expect(await answerQuestion(pool, priya.id, q.id, "Practise product sense cases.", new Date())).toBe("answered");
    expect(await answerQuestion(pool, priya.id, q.id, "Again", new Date())).toBe("not_open");
    expect((await questionByToken(pool, q.token))).toMatchObject({ status: "answered", answer: "Practise product sense cases." });
    expect(await notes("question_answer_guest")).toEqual([{ recipient: "asha@example.in", dedupe_key: `question:${q.id}:question_answer_guest` }]);
    // A declined free question is just declined; the guest is told.
    const found = (await publicOffer(pool, "priya"))!;
    const free = await startQuestion({ pool, auth: null, orders: null }, found, ask(), new Date());
    const id = (await questionByToken(pool, free.token))!.id;
    expect(await declineQuestion(pool, priya.id, id, new Date())).toBe("declined");
    expect((await questionByToken(pool, free.token))?.status).toBe("declined");
  });

  it("takes payment for a paid question, confirms it from Checkout and refunds it in full when declined", async () => {
    await saveOffer(pool, priya.id, { active: true, priceMinor: 49_900, responseDays: 3, intro: "" });
    // Paid questions need a paid plan: on Free the guest is told payments aren't available.
    const fake = fakeRazorpay();
    const deps = { pool, authFor: async () => auth, ordersFor: () => fake.orders, planFor: async () => "free" as const };
    expect(await handleStartQuestion(pool, deps, "priya", ask(), new Date())).toMatchObject({ status: 409 });

    const paidDeps = { ...deps, planFor: async () => "solo" as const };
    const started = await handleStartQuestion(pool, paidDeps, "priya", ask(), new Date());
    expect(started).toMatchObject({ status: 200, body: { status: "pending", payment: { provider: "razorpay", keyId: "rzp_test_QuestionHost1", amount: 49_900 } } });
    const { token, payment } = started.body as { token: string; payment: { orderId: string } };
    expect((await listQuestions(pool, priya.id)).some((q) => q.token === token)).toBe(false); // not sent until paid
    fake.state.payments.set("pay_q1", { id: "pay_q1", order_id: payment.orderId, amount: 49_900, currency: "INR", status: "authorized" });
    expect(await handleConfirmQuestion(paidDeps, { token, paymentId: "pay_q1", signature: "f".repeat(64) }, new Date())).toMatchObject({ status: 400, body: { error: "bad_signature" } });
    expect(await handleConfirmQuestion(paidDeps, { token, paymentId: "pay_q1", signature: sign(payment.orderId, "pay_q1") }, new Date())).toEqual({ status: 200, body: { status: "open" } });
    const q = (await questionByToken(pool, token))!;
    expect(q).toMatchObject({ status: "open", priceMinor: 49_900 });

    expect(await declineQuestion(pool, priya.id, q.id, new Date())).toBe("declined");
    expect((await questionByToken(pool, token))?.status).toBe("refund_pending");
    const jobs = await runQuestionJobs({ pool, authFor: async () => auth, ordersFor: () => fake.orders }, new Date(Date.now() + 120_000));
    expect(jobs).toMatchObject({ refunded: 1, errors: 0 });
    expect(fake.state.refunds).toEqual([expect.objectContaining({ receipt: `q-${q.id}` })]);
    expect((await questionByToken(pool, token))?.status).toBe("refunded");
  });

  it("settles a payment the browser never confirmed, and gives up on one never paid after a day", async () => {
    const found = (await publicOffer(pool, "priya"))!;
    const fake = fakeRazorpay();
    const paid = await startQuestion({ pool, auth, orders: fake.orders }, found, ask(), new Date());
    fake.state.payments.set("pay_q2", { id: "pay_q2", order_id: paid.payment!.orderId, amount: 49_900, currency: "INR", status: "captured" });
    const unpaid = await startQuestion({ pool, auth, orders: fake.orders }, found, ask(), new Date());
    const deps = { pool, authFor: async () => auth, ordersFor: () => fake.orders };
    expect(await runQuestionJobs(deps, new Date(Date.now() + 120_000))).toMatchObject({ opened: 1, failed: 0 });
    expect((await questionByToken(pool, paid.token))?.status).toBe("open");
    expect(await runQuestionJobs(deps, new Date(Date.now() + 2 * 86_400_000))).toMatchObject({ failed: 1 });
    expect((await questionByToken(pool, unpaid.token))?.status).toBe("failed");
  });

  it("collected by Hourhand for a split host, the order carries the Route transfer", async () => {
    const found = (await publicOffer(pool, "priya"))!;
    const platform = { ...keyPairAuth("rzp_test_PlatformQ123", "p"), collection: { mode: "split" as const, commissionBps: 1000, routeAccount: "acc_HostQ1234" } };
    const fake = fakeRazorpay(platform);
    const r = await startQuestion({ pool, auth: platform, orders: fake.orders }, found, ask(), new Date());
    expect(fake.state.orders[0].transfers).toEqual([{ account: "acc_HostQ1234", amount: 44_910, currency: "INR", on_hold: false }]);
    const { rows: [row] } = await pool.query("select collected_via, commission_minor, transfer_account from questions where token = $1", [r.token]);
    expect(row).toEqual({ collected_via: "platform", commission_minor: 4_990, transfer_account: "acc_HostQ1234" });
  });

  it("tells the host's webhooks about a new question and its answer", async () => {
    await saveOffer(pool, priya.id, { active: true, priceMinor: 0, responseDays: 2, intro: "" });
    const hook = (await pool.query(
      "insert into webhook_endpoints (user_id, url, secret_sealed, events) values ($1, 'https://hooks.example.com/q', '\\x00', $2) returning id",
      [priya.id, ["question.received", "question.answered"]])).rows[0].id as string;
    const now = new Date("2045-06-01T09:00:00Z");
    const r = await startQuestion({ pool, auth: null, orders: null }, (await publicOffer(pool, "priya"))!, ask({ name: "Ravi", email: "ravi@example.in", question: "Which offer should I take?" }), now);
    const q = (await questionByToken(pool, r.token))!;
    expect(await answerQuestion(pool, priya.id, q.id, "The second one.", now)).toBe("answered");
    const { rows } = await pool.query("select event, payload from webhook_deliveries where endpoint_id = $1 order by event desc", [hook]);
    expect(rows.map((x) => x.event)).toEqual(["question.received", "question.answered"]);
    expect(rows[0].payload.data).toMatchObject({ question_id: q.id, guest_name: "Ravi", guest_email: "ravi@example.in", question: "Which offer should I take?", price_minor: 0, due_at: "2045-06-03T09:00:00.000Z" });
    expect(rows[1].payload.data).toMatchObject({ question_id: q.id, answer: "The second one.", answered_at: now.toISOString() });
    await pool.query("delete from webhook_endpoints where id = $1", [hook]);
  });

  it("reminds the host a day before a question is due, and closes it a day after, refunding a paid one in full", async () => {
    const DAY = 86_400_000;
    const t0 = new Date("2050-01-01T10:00:00Z");
    const at = (days: number) => new Date(t0.getTime() + days * DAY);
    const fake = fakeRazorpay();
    // A paid question, answer due in 3 days, and a free one due in 2.
    await saveOffer(pool, priya.id, { active: true, priceMinor: 49_900, responseDays: 3, intro: "" });
    const paid = await startQuestion({ pool, auth, orders: fake.orders }, (await publicOffer(pool, "priya"))!, ask(), t0);
    const paidId = (await questionByToken(pool, paid.token))!.id;
    fake.state.payments.set("pay_d1", { id: "pay_d1", order_id: paid.payment!.orderId, amount: 49_900, currency: "INR", status: "captured" });
    expect(await applyQuestionPayment(pool, paidId, "pay_d1", t0)).toBe("open");
    await saveOffer(pool, priya.id, { active: true, priceMinor: 0, responseDays: 2, intro: "" });
    const free = await startQuestion({ pool, auth: null, orders: null }, (await publicOffer(pool, "priya"))!, ask(), t0);
    const freeId = (await questionByToken(pool, free.token))!.id;
    // An answered question is never touched.
    const done = await startQuestion({ pool, auth: null, orders: null }, (await publicOffer(pool, "priya"))!, ask(), t0);
    const doneId = (await questionByToken(pool, done.token))!.id;
    expect(await answerQuestion(pool, priya.id, doneId, "Done.", t0)).toBe("answered");

    const due = async (id: string) => (await notes("question_due_host")).filter((r) => r.dedupe_key.includes(id));
    // 1.5 days in: only the free one is due within a day, and it's reminded once however often the pass runs.
    await runQuestionDeadlines(pool, at(1.5));
    await runQuestionDeadlines(pool, at(1.6));
    expect(await due(freeId)).toEqual([{ recipient: priya.email, dedupe_key: `question:${freeId}:question_due_host` }]);
    expect(await due(paidId)).toEqual([]);
    expect((await questionByToken(pool, free.token))?.status).toBe("open");

    // 3.5 days in: the free one is a day and a half late and is closed; the paid one is only half a day late.
    await runQuestionDeadlines(pool, at(3.5));
    expect(await questionByToken(pool, free.token)).toMatchObject({ status: "declined", expired: true });
    expect((await questionByToken(pool, paid.token))?.status).toBe("open");
    // A day after it was due, the paid one is closed and goes to the refund pass, which refunds it in full.
    await runQuestionDeadlines(pool, at(4));
    expect(await questionByToken(pool, paid.token)).toMatchObject({ status: "refund_pending", expired: true });
    expect(await answerQuestion(pool, priya.id, paidId, "Too late.", at(4))).toBe("not_open");
    await runQuestionJobs({ pool, authFor: async () => auth, ordersFor: () => fake.orders }, at(4.1));
    expect((await questionByToken(pool, paid.token))?.status).toBe("refunded");
    expect(fake.state.refunds).toContainEqual(expect.objectContaining({ receipt: `q-${paidId}` }));
    for (const id of [freeId, paidId]) {
      expect((await notes("question_expired_guest")).filter((r) => r.dedupe_key.includes(id))).toEqual([{ recipient: "asha@example.in", dedupe_key: `question:${id}:question_expired_guest` }]);
      expect((await notes("question_expired_host")).filter((r) => r.dedupe_key.includes(id))).toEqual([{ recipient: priya.email, dedupe_key: `question:${id}:question_expired_host` }]);
    }
    expect((await questionByToken(pool, done.token))).toMatchObject({ status: "answered", expired: false });
  });
});

describe("question emails", () => {
  const base = {
    hostName: "Priya", hostEmail: "priya@example.in", guestName: "Asha", guestEmail: "asha@example.in", question: "How do I prepare?", answer: "Practise.",
    priceMinor: 49_900, dueAt: new Date("2034-03-03T10:00:00Z"), timezone: "Asia/Kolkata", guestUrl: "https://h/q/t", dashboardUrl: "https://h/dashboard/questions",
  };
  it("sends the guest the answer, and the host a note in their own language", () => {
    const answer = renderQuestionMail("question_answer_guest", base);
    expect(answer.subject).toBe("Priya answered your question");
    expect(answer.text).toContain("Practise.");
    expect(renderQuestionMail("question_host", { ...base, hostLocale: "ta" }).subject).toBe("Asha இடமிருந்து புதிய கேள்வி");
    expect(renderQuestionMail("question_declined_guest", base).text).toContain("refunded in full");
  });
  it("tells the host a question is due, and both sides when one was closed for missing it", () => {
    expect(renderQuestionMail("question_due_host", base).subject).toBe("Answer Asha's question by tomorrow");
    const guest = renderQuestionMail("question_expired_guest", base);
    expect(guest.subject).toBe("Priya didn't answer your question in time");
    expect(guest.text).toContain("refunded in full");
    expect(renderQuestionMail("question_expired_guest", { ...base, priceMinor: 0 }).text).not.toContain("refund");
    expect(renderQuestionMail("question_expired_host", base).text).toContain("refunding their payment in full");
    expect(renderQuestionMail("question_expired_host", { ...base, hostLocale: "hi" }).subject).toBe("Asha का सवाल बंद कर दिया गया");
  });
});
