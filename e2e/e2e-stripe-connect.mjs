// Roadmap 1.4 end to end: a host outside India connects Stripe and a guest pays through Checkout on the host's account,
// against the local server and the fake Stripe only.
// Usage: node e2e/e2e-stripe-connect.mjs <port> <server-log> <database-url> <stripe-port>
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const lastLink = (text, email) => [...text.matchAll(/\[dev\] email to ([^:]+): Your Hourhand sign-in link\n[\s\S]*?\nSign in: (\S+)/g)]
  .filter((m) => m[1] === email).at(-1)?.[2];
const [port, logPath, databaseUrl, stripePort] = process.argv.slice(2);
const B = `http://localhost:${port}`;
const S = `http://127.0.0.1:${stripePort}`;
const HOOK = "e2e-connect-hook";
let fail = 0;
const check = (ok, label) => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const t = () => AbortSignal.timeout(15000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => readFileSync(logPath, "utf8");
async function waitFor(pred, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(500); } return pred(); }
const fake = async () => (await fetch(`${S}/__state`)).json();
const ip = "203.0.113.91";

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    take(res) {
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(";"); const i = pair.indexOf("=");
        const name = pair.slice(0, i), value = pair.slice(i + 1);
        if (/max-age=0/i.test(raw) || value === "") cookies.delete(name); else cookies.set(name, value);
      }
    },
  };
}
const get = async (path, j) => {
  const res = await fetch(B + path, { redirect: "manual", headers: { "x-forwarded-for": ip, ...(j ? { cookie: j.header() } : {}) }, signal: t() });
  j?.take(res);
  const text = res.text.bind(res);
  res.text = async () => (await text()).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
  return res;
};
async function signIn(email) {
  await fetch(`${B}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: B, "x-forwarded-for": ip }, body: JSON.stringify({ email, callbackURL: "/dashboard" }), signal: t() });
  await sleep(300);
  const j = jar();
  await get(lastLink(log(), email).replace(/^https?:\/\/[^/]+/, ""), j);
  return j;
}
async function submitForm(j, path, marker, fields) {
  const html = await (await get(path, j)).text();
  const form = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((f) => f.includes(marker));
  if (!form) return null;
  const fd = new FormData();
  for (const m of form.matchAll(/<input[^>]*name="([^"]+)"(?:\s+value="([^"]*)")?[^>]*>/g)) if (m[1].startsWith("$ACTION")) fd.append(m[1], m[2] ?? "");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(B + path, { method: "POST", body: fd, redirect: "manual", headers: { cookie: j.header(), origin: B, "x-forwarded-for": ip }, signal: t() });
  j.take(res);
  return res;
}
const hook = (body, secret = HOOK, at = Date.now()) => {
  const raw = JSON.stringify(body);
  const ts = Math.floor(at / 1000);
  return fetch(`${B}/api/webhooks/stripe-connect`, {
    method: "POST", body: raw, signal: t(),
    headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}` },
  });
};

await sleep(2500);
check(log().includes("Stripe on)"), "job runner started with Stripe on");
const pool = new pg.Pool({ connectionString: databaseUrl });
const { rows: [priya] } = await pool.query("select id, email from users where slug = 'priya'");
await pool.query("insert into subscriptions (user_id, plan, interval, provider, provider_subscription_id, status, current_period_end) values ($1, 'solo', 'month', 'stripe', 'sub_e2e_s', 'active', now() + interval '20 days')", [priya.id]);

// --- Connect (part A)
const pj = await signIn(priya.email);
let html = await (await get("/dashboard/integrations", pj)).text();
check(html.includes("Connect Stripe") && html.includes("Country of your business") && !html.includes('value="IN"'), "Integrations offers Stripe with a country choice (no India)");
let res = await submitForm(pj, "/dashboard/integrations", 'name="country"', { country: "US" });
const onboarding = res?.headers.get("location") ?? "";
check(res?.status === 303 && onboarding.startsWith("https://connect.stripe.fake/setup/acct_"), `Connect Stripe sends the host to Stripe's onboarding (${res?.status} ${onboarding})`);
const row = (await pool.query("select public_id, onboarding, currency, credentials_encrypted from integrations where user_id = $1 and provider = 'stripe'", [priya.id])).rows[0];
check(row?.onboarding === "pending" && row.currency === "USD" && !Buffer.from(row.credentials_encrypted).toString("latin1").includes(row.public_id), "account stored sealed, pending, USD");
const acct = row.public_id;
res = await get("/api/payments/stripe/return", pj);
check(res.headers.get("location")?.endsWith("/dashboard/integrations?stripe=pending"), "back from Stripe unfinished: still pending");
html = await (await get("/dashboard/integrations?stripe=pending", pj)).text();
check(html.includes("Setup not finished") && html.includes("Continue setup in Stripe"), "page offers to continue setup");
check(!html.includes("Key ID"), "Razorpay can't be connected alongside Stripe");
res = await get("/api/payments/stripe/refresh", pj);
check(res.headers.get("location")?.startsWith(`https://connect.stripe.fake/setup/${acct}/`), "refresh_url makes a fresh link for the same account");
check((await fake()).accounts.length === 1, "only ever one Stripe account created");
await fetch(`${S}/__activate?account=${acct}`, { method: "POST" });
res = await get("/api/payments/stripe/return", pj);
check(res.headers.get("location")?.endsWith("?stripe=active"), "finished onboarding reads as active");
html = await (await get("/dashboard/integrations?stripe=active", pj)).text();
check(html.includes("Taking payments") && html.includes("USD") && html.includes(`acct_••••${acct.slice(-4)}`), "page shows Taking payments, USD and the masked account");

// --- Pay (part B)
await pool.query("update event_types set price_minor = 4500, currency = 'USD' where user_id = $1 and slug = 'coaching'", [priya.id]);
check((await (await get("/priya/coaching")).text()).includes("$45"), "booking page shows $45");
const pq = await pool.query("select q.id from custom_questions q join event_types e on e.id = q.event_type_id where e.slug = 'coaching' and e.user_id = $1", [priya.id]);
const answers = Object.fromEntries(pq.rows.map((r) => [r.id, "Plan"]));
const from = new Date().toISOString(), to = new Date(Date.now() + 14 * 864e5).toISOString();
const slots = (await (await fetch(`${B}/api/slots?slug=priya&event=coaching&from=${from}&to=${to}&tz=Europe/London`, { signal: t() })).json()).slots;
const book = (start, email) => fetch(`${B}/api/bookings`, {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200)}` }, signal: t(),
  body: JSON.stringify({ slug: "priya", event: "coaching", start, name: "Sam Lee", email, timezone: "Europe/London", answers, idempotencyKey: `e2e-s-${Math.random()}`, locale: "en" }),
});
const bookingRow = async (id) => (await pool.query("select b.status, p.status as pay_status, p.provider_order_id from bookings b left join payments p on p.booking_id = b.id where b.id = $1", [id])).rows[0];

const g1 = `stripe-paid-${Date.now()}@example.com`;
res = await book(slots.at(-1), g1);
const b1 = await res.json();
check(res.status === 201 && b1.payment?.provider === "stripe" && b1.payment.url?.startsWith("https://checkout.stripe.fake/") && b1.payment.currency === "USD", `paid booking returns a Stripe Checkout page (${res.status})`);
const cs1 = (await bookingRow(b1.bookingId)).provider_order_id;
const sess1 = (await fake()).sessions.find((x) => x.id === cs1);
check(sess1?.account === acct && sess1.params.success_url.includes(`/booked/${b1.bookingId}?session_id={CHECKOUT_SESSION_ID}`), "session is on the host's account and returns to the booked page");
res = await get(`/priya/coaching/booked/${b1.bookingId}?session_id=${cs1}`);
check((await bookingRow(b1.bookingId)).status === "pending_payment" && (await res.text()).includes("Confirming"), "returning without paying confirms nothing");
check(!log().includes(`[dev] email to ${g1}`), "no email before payment");
await fetch(`${S}/__pay?session=${cs1}`, { method: "POST" });
html = await (await get(`/priya/coaching/booked/${b1.bookingId}?session_id=${cs1}`)).text();
check(html.includes("You're booked") && (await bookingRow(b1.bookingId)).pay_status === "paid", "after paying, the verified return confirms the booking");
check(await waitFor(() => new RegExp(`\\[dev\\] email to ${g1.replace(/[.]/g, "\\.")}: Booked:[\\s\\S]*?\\$45`).test(log())), "guest confirmation sent, showing $45");

// Webhook path
const g2 = `stripe-hook-${Date.now()}@example.com`;
res = await book(slots[0], g2);
const b2 = await res.json();
check(res.status === 201, `second paid booking held (${res.status} ${b2.error ?? ""})`);
const cs2 = (await bookingRow(b2.bookingId)).provider_order_id;
await fetch(`${S}/__pay?session=${cs2}`, { method: "POST" });
const evt = { id: `evt_e2e_${Date.now()}`, type: "checkout.session.completed", account: acct, livemode: false, data: { object: { id: cs2 } } };
res = await hook(evt, "wrong-secret");
check(res.status === 400, `a badly signed webhook is refused (${res.status})`);
res = await hook(evt, HOOK, Date.now() - 10 * 60_000);
check(res.status === 400, "a 10-minute-old webhook is refused");
check((await bookingRow(b2.bookingId)).status === "pending_payment", "…and neither confirmed anything");
res = await hook(evt);
check(res.status === 200 && (await res.json()).outcome === "processed" && (await bookingRow(b2.bookingId)).status === "confirmed", "a signed webhook confirms from the verified session");
res = await hook(evt);
check(res.status === 200 && (await res.json()).outcome === "duplicate", "the same event again is a duplicate");

// Switching guard, then refund on cancel
const g3 = `stripe-held-${Date.now()}@example.com`;
const b3 = await (await book(slots[Math.floor(slots.length / 2)], g3)).json();
res = await submitForm(pj, "/dashboard/integrations", ">Disconnect<", {});
check(res?.headers.get("location")?.includes("stripe_error=busy"), "Stripe can't be disconnected while a guest is paying");
await pool.query("update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', hold_expires_at = null where id = $1", [b3.bookingId]);
await pool.query("update payments set status = 'failed' where booking_id = $1", [b3.bookingId]);

res = await fetch(`${B}/api/b/${b1.manageToken}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Can't make it" }), signal: t() });
check(res.status === 200, `guest cancels the paid booking (${res.status})`);
check(await waitFor(() => new RegExp(`\\[dev\\] email to ${g1.replace(/[.]/g, "\\.")}: Cancelled:[\\s\\S]*?\\$45[\\s\\S]*?refunded`).test(log())), "cancellation email says the $45 is being refunded");
check(await waitFor(async () => (await bookingRow(b1.bookingId)).pay_status === "refunded"), "the job runner refunds it in full on the host's account");
const refunds = (await fake()).refunds;
check(refunds.length === 1 && refunds[0].account === acct && refunds[0].amount === 4500, "exactly one refund, $45, on the host's account");

await pool.end();
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
