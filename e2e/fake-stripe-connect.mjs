// A fake Stripe for the Connect e2e run: the same in-memory fake the unit tests use, served over HTTP, plus test controls.
// Usage: node e2e/fake-stripe-connect.mjs <port>
import { createServer } from "node:http";
import { fakeStripe } from "../src/lib/payments/fake-stripe.ts";

const [port] = process.argv.slice(2);
const fake = fakeStripe();
const read = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await read(req);
  const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
  // Test controls: what the guest or the host would do in Stripe's own pages.
  if (url.pathname === "/__state") return send(200, { accounts: [...fake.state.accounts.values()], sessions: [...fake.state.sessions.values()], refunds: fake.state.refunds });
  if (url.pathname === "/__activate") { fake.state.accounts.get(url.searchParams.get("account")).cardPayments = "active"; return send(200, { ok: true }); }
  if (url.pathname === "/__pay") return send(200, fake.pay(url.searchParams.get("session")));
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]));
  const r = await fake.fetchImpl(`https://api.stripe.com${url.pathname}${url.search}`, { method: req.method, headers, body: body || undefined });
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(await r.text());
}).listen(Number(port), "127.0.0.1", () => console.log(`fake Stripe on ${port}`));
