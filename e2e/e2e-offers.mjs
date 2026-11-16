// Roadmap 3.3 offers (coupons, campaigns, first session, pay what you can) end to end against the local server and the fake host-side Razorpay.
// Usage: node e2e/e2e-offers.mjs <port> <server-log> <database-url> <rzp-port>
import { readFileSync } from "node:fs";
import pg from "pg";

const lastLink = (text, email) => [...text.matchAll(/\[dev\] email to ([^:]+): Your Hourhand sign-in link\n[\s\S]*?\nSign in: (\S+)/g)]
  .filter((m) => m[1] === email).at(-1)?.[2];
const [port, logPath, databaseUrl, rzpPort] = process.argv.slice(2);
const B = `http://localhost:${port}`;
const R = `http://127.0.0.1:${rzpPort}`;
let fail = 0;
const check = (ok, label) => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const t = () => AbortSignal.timeout(15000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => readFileSync(logPath, "utf8");
async function waitFor(pred, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(500); } return pred(); }
const fake = async () => (await fetch(`${R}/__state`)).json();
const ip = "203.0.113.93";

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
  res.text = async () => (await text()).replace(/<!-- -->/g, "");
  return res;
};
async function signIn(email) {
  await fetch(`${B}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: B, "x-forwarded-for": ip }, body: JSON.stringify({ email, callbackURL: "/dashboard" }), signal: t() });
  await sleep(300);
  const j = jar();
  await get(lastLink(log(), email).replace(/^https?:\/\/[^/]+/, ""), j);
  return j;
}
/** Posts the no-JavaScript form on `path` whose markup contains `marker`, with `fields` filled in. */
async function submitForm(j, path, marker, fields) {
  const html = await (await get(path, j)).text();
  const form = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((f) => f.includes(marker));
  if (!form) return null;
  const fd = new FormData();
  for (const m of form.matchAll(/<input[^>]*name="([^"]+)"(?:\s+value="([^"]*)")?[^>]*>/g)) if (m[1].startsWith("$ACTION")) fd.append(m[1], (m[2] ?? "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(B + path, { method: "POST", body: fd, redirect: "manual", headers: { cookie: j.header(), origin: B, "x-forwarded-for": ip }, signal: t() });
  j.take(res);
  return res;
}
await sleep(2500);
const pool = new pg.Pool({ connectionString: databaseUrl });
const { rows: [priya] } = await pool.query("select id, email, timezone from users where slug = 'priya'");
const pj = await signIn(priya.email);
let html = await (await get("/dashboard/offers", pj)).text();
check(html.includes("They come with the Solo and Duo plans"), "Free plan: offers page explains it needs Solo or Duo");
await pool.query("insert into subscriptions (user_id, plan, interval, provider, provider_subscription_id, status, current_period_end) values ($1, 'solo', 'month', 'razorpay', 'sub_e2e_offers', 'active', now() + interval '20 days')", [priya.id]);
let res = await submitForm(pj, "/dashboard/integrations", 'name="keyId"', { keyId: "rzp_test_e2ehost1234", keySecret: "e2e-host-key" });
check(res?.status === 303, "Razorpay keys connected");
const CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const check14 = (s) => { let sum = 0; for (let i = 0; i < 14; i++) { const p = CH.indexOf(s[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); } return CH[(36 - (sum % 36)) % 36]; };
await submitForm(pj, "/dashboard/invoices", 'name="gstin"', { legalName: "Priya Sharma Coaching LLP", address: "12 MG Road, Bengaluru 560001", gstin: "29AAPFU0939F1Z" + check14("29AAPFU0939F1Z"), sac: "999293", rate: "18", invoicePrefix: "PRS" });
await pool.query("update event_types set price_minor = 118000, currency = 'INR' where user_id = $1 and slug = 'coaching'", [priya.id]);
const { rows: [coaching] } = await pool.query("select id from event_types where user_id = $1 and slug = 'coaching'", [priya.id]);

html = await (await get("/dashboard/offers", pj)).text();
check(html.includes("Discount codes") && html.includes("Campaigns") && html.includes("Pay what you can"), "offers page loads on Solo");
await submitForm(pj, "/dashboard/offers", 'name="maxUsesPerEmail"', { code: "diwali20", kind: "percent", value: "20", expiresOn: "", maxUses: "5", maxUsesPerEmail: "1" });
check((await pool.query("select code, discount_value, max_uses from offer_coupons where user_id = $1", [priya.id])).rows[0]?.code === "DIWALI20", "coupon DIWALI20 created from the form");
const day = (offset) => new Date(Date.now() + offset * 864e5 + 330 * 6e4).toISOString().slice(0, 10);
await submitForm(pj, "/dashboard/offers", 'name="banner"', { name: "Festive week", banner: "10% off every session this week", kind: "percent", value: "10", startsOn: day(0), endsOn: day(2) });
check((await pool.query("select name from offer_campaigns where user_id = $1", [priya.id])).rowCount === 1, "campaign scheduled from the form");

html = await (await get("/priya")).text();
check(html.includes("10% off every session this week"), "campaign banner on the host's page");
html = await (await get("/priya/coaching")).text();
check(html.includes("₹1,062 with Festive week") && html.includes("Festive week"), "event page shows the campaign price and banner");

const quote = await (await fetch(`${B}/api/offers/quote`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, signal: t(),
  body: JSON.stringify({ slug: "priya", event: "coaching", couponCode: "DIWALI20" }) })).json();
check(quote.chargeMinor === 94400 && quote.offer?.code === "DIWALI20", `quote: DIWALI20 beats the campaign (${quote.chargeMinor})`);
const bad = await fetch(`${B}/api/offers/quote`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, signal: t(), body: JSON.stringify({ slug: "priya", event: "coaching", couponCode: "NOPE99" }) });
check(bad.status === 400, "unknown code refused");

const pq = await pool.query("select id from custom_questions where event_type_id = $1", [coaching.id]);
const answers = Object.fromEntries(pq.rows.map((r) => [r.id, "Plan"]));
const slots = (await (await fetch(`${B}/api/slots?slug=priya&event=coaching&from=${new Date().toISOString()}&to=${new Date(Date.now() + 14 * 864e5).toISOString()}&tz=Asia/Kolkata`)).json()).slots;
const email = `offer-guest-${Date.now()}@example.com`;
const b = await (await fetch(`${B}/api/bookings`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, signal: t(),
  body: JSON.stringify({ slug: "priya", event: "coaching", start: slots.at(-1), name: "Asha Rao", email, timezone: "Asia/Kolkata", answers, idempotencyKey: `e2e-offer-${Date.now()}`, couponCode: "diwali20" }) })).json();
check(b.payment?.amount === 94400 && b.offer?.kind === "coupon", `booking with DIWALI20 opens a ₹944 order (${b.payment?.amount})`);
const p = await (await fetch(`${R}/__pay`, { method: "POST", body: JSON.stringify({ orderId: b.payment.orderId }) })).json();
res = await fetch(`${B}/api/bookings/pay`, { method: "POST", headers: { "content-type": "application/json" }, signal: t(),
  body: JSON.stringify({ manageToken: b.manageToken, paymentId: p.razorpay_payment_id, signature: p.razorpay_signature }) });
check(res.status === 200, "discounted booking paid");
html = await (await get(`/priya/coaching/booked/${b.bookingId}`)).text();
check(html.includes("₹944 (₹1,180 less ₹236, code DIWALI20)"), "confirmation page explains the discount");
check(await waitFor(() => log().includes("₹944 (₹1,180 less ₹236, code DIWALI20)")), "confirmation email explains the discount");
const { rows: [inv] } = await pool.query("select v.token from invoices v join payments y on y.id = v.payment_id where y.booking_id = $1 and v.kind = 'invoice'", [b.bookingId]);
html = await (await get(`/invoice/${inv.token}`)).text();
for (const s of ["Value before discount", "₹1,000", "Discount (Code DIWALI20)", "₹200", "Taxable value", "₹800", "CGST 9%", "₹72", "₹944"]) check(html.includes(s), `invoice shows ${s}`);
html = await (await get("/dashboard/offers", pj)).text();
check(html.includes("Used 1 of 5"), "host sees the code's use");

// Pay what you can on the same event type: the client's pick is the price, a code isn't taken with it.
await submitForm(pj, "/dashboard/offers", 'name="suggested"', { eventTypeId: coaching.id, min: "500", suggested: "1200", max: "2000", note: "Pay what fits your budget." });
html = await (await get("/priya/coaching")).text();
check(html.includes("₹500–₹2,000"), "event page shows the sliding range");
const s2 = await (await fetch(`${B}/api/bookings`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, signal: t(),
  body: JSON.stringify({ slug: "priya", event: "coaching", start: slots[0], name: "Ravi", email: `slide-${Date.now()}@example.com`, timezone: "Asia/Kolkata", answers, idempotencyKey: `e2e-slide-${Date.now()}`, payMinor: 70000 }) })).json();
check(s2.payment?.amount === 70000, `sliding-scale pick charged as chosen (${s2.payment?.amount ?? JSON.stringify(s2)})`);
await pool.end();
console.log(fail ? `${fail} FAILED` : "ALL OK");
process.exit(fail ? 1 : 0);
