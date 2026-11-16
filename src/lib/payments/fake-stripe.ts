// Test-only: an in-memory Stripe for the Connect calls Hourhand makes, served through an injected fetch (the same pattern
// as the fake Razorpay in booking-payments.test.ts). Never imported by app code.

export interface FakeStripeAccount {
  id: string; country: string; currency: string; livemode: boolean; cardPayments: "active" | "pending" | "restricted" | "unsupported"; email: string;
}

export interface FakeSession {
  id: string; account: string; status: "open" | "complete" | "expired"; payment_status: "paid" | "unpaid"; amount_total: number; currency: string;
  url: string; payment_intent: string | null; metadata: Record<string, string>; params: Record<string, string>; expires_at: number;
}
export interface FakeRefund { id: string; account: string; payment_intent: string; amount: number; status: string; idempotencyKey: string | null }

export function fakeStripe() {
  const state = {
    sessions: new Map<string, FakeSession>(),
    sessionKeys: new Map<string, { id: string; body: string }>(),
    refunds: [] as FakeRefund[],
    refundKeys: new Map<string, string>(),
    failSessions: false,
    failGetSession: false,
    failRefunds: false,
    accounts: new Map<string, FakeStripeAccount>(),
    /** Idempotency keys seen on account creation, and the account each one created. */
    keys: new Map<string, string>(),
    creates: 0,
    links: [] as { account: string; returnUrl: string; refreshUrl: string }[],
    requests: [] as { method: string; path: string; headers: Record<string, string>; body: unknown }[],
    failNext: null as null | number,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const v2Account = (a: FakeStripeAccount) => ({
    id: a.id, object: "v2.core.account", livemode: a.livemode, dashboard: "full", contact_email: a.email,
    identity: { country: a.country.toLowerCase() },
    defaults: { currency: a.currency.toLowerCase(), responsibilities: { fees_collector: "stripe", losses_collector: "stripe", requirements_collector: "stripe" } },
    configuration: { merchant: { capabilities: { card_payments: { status: a.cardPayments, status_details: [] } } } },
  });
  const CURRENCY: Record<string, string> = { US: "usd", GB: "gbp", IE: "eur", DE: "eur", FR: "eur", CA: "cad", AU: "aud" };

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === "string" && headers["content-type"] === "application/json" ? JSON.parse(init.body) : init.body;
    state.requests.push({ method, path: u.pathname, headers, body });
    if (state.failNext) {
      const status = state.failNext;
      state.failNext = null;
      return json({ error: { type: "api_error", message: "fake outage" } }, status);
    }
    if (!headers.authorization?.startsWith("Bearer sk_")) return json({ error: { type: "invalid_request_error", message: "bad key" } }, 401);
    if (u.pathname.startsWith("/v2/") && !headers["stripe-version"]) return json({ error: { type: "invalid_request_error", message: "v2 needs Stripe-Version" } }, 400);

    if (method === "POST" && u.pathname === "/v2/core/accounts") {
      const b = body as { identity: { country: string }; contact_email: string };
      const key = headers["idempotency-key"];
      if (key && state.keys.has(key)) return json(v2Account(state.accounts.get(state.keys.get(key)!)!));
      state.creates += 1;
      const country = b.identity.country.toUpperCase();
      const a: FakeStripeAccount = {
        id: `acct_fake${state.creates}${Math.random().toString(36).slice(2, 8)}`, country, currency: CURRENCY[country] ?? "usd",
        livemode: false, cardPayments: "pending", email: b.contact_email,
      };
      state.accounts.set(a.id, a);
      if (key) state.keys.set(key, a.id);
      return json(v2Account(a));
    }
    if (method === "POST" && u.pathname === "/v2/core/account_links") {
      const b = body as { account: string; use_case: { account_onboarding: { return_url: string; refresh_url: string } } };
      if (!state.accounts.has(b.account)) return json({ error: { type: "invalid_request_error", code: "not_found", message: "no such account" } }, 404);
      state.links.push({ account: b.account, returnUrl: b.use_case.account_onboarding.return_url, refreshUrl: b.use_case.account_onboarding.refresh_url });
      return json({ object: "v2.core.account_link", account: b.account, url: `https://connect.stripe.fake/setup/${b.account}/${state.links.length}` });
    }
    const acct = /^\/v2\/core\/accounts\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && acct) {
      const a = state.accounts.get(acct[1]);
      return a ? json(v2Account(a)) : json({ error: { type: "invalid_request_error", code: "not_found", message: "no such account" } }, 404);
    }
    // ----- v1, as a connected account (direct charges) -----
    const account = headers["stripe-account"];
    if (u.pathname.startsWith("/v1/") && (!account || !state.accounts.has(account))) {
      return json({ error: { type: "invalid_request_error", message: "No such account (Stripe-Account)" } }, 403);
    }
    const form = typeof init.body === "string" && headers["content-type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    const key = headers["idempotency-key"] ?? null;
    const noSuch = (what: string) => json({ error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` } }, 404);
    const view = (x: FakeSession) => ({
      id: x.id, object: "checkout.session", status: x.status, payment_status: x.payment_status, amount_total: x.amount_total, currency: x.currency,
      url: x.status === "open" ? x.url : null, payment_intent: x.payment_intent, metadata: x.metadata, expires_at: x.expires_at,
    });
    if (method === "POST" && u.pathname === "/v1/checkout/sessions") {
      if (state.failSessions) return json({ error: { type: "api_error", message: "checkout down" } }, 503);
      if (key && state.sessionKeys.has(key)) {
        const prior = state.sessionKeys.get(key)!;
        // Stripe refuses a reused key with different parameters.
        if (prior.body !== init.body) return json({ error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" } }, 400);
        return json(view(state.sessions.get(prior.id)!));
      }
      const id = `cs_test_${Math.random().toString(36).slice(2, 14)}`;
      const x: FakeSession = {
        id, account, status: "open", payment_status: "unpaid", amount_total: Number(form["line_items[0][price_data][unit_amount]"]),
        currency: form["line_items[0][price_data][currency]"], url: `https://checkout.stripe.fake/c/${id}`, payment_intent: null,
        metadata: { hourhand_ref: form["metadata[hourhand_ref]"] }, params: form, expires_at: Number(form.expires_at),
      };
      state.sessions.set(id, x);
      if (key) state.sessionKeys.set(key, { id, body: String(init.body) });
      return json(view(x));
    }
    const cs = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(u.pathname);
    if (cs) {
      const x = state.sessions.get(cs[1]);
      // Objects on one connected account are invisible from another.
      if (!x || x.account !== account) return noSuch("checkout.session");
      if (method === "GET") {
        if (state.failGetSession) return json({ error: { type: "api_error", message: "sessions down" } }, 503);
        return json(view(x));
      }
      if (cs[2] && method === "POST") {
        if (x.status !== "open") return json({ error: { type: "invalid_request_error", message: "Only open sessions can be expired" } }, 400);
        x.status = "expired";
        return json(view(x));
      }
    }
    if (u.pathname === "/v1/refunds" && method === "GET") {
      const pi = u.searchParams.get("payment_intent");
      return json({ object: "list", data: state.refunds.filter((r) => r.account === account && r.payment_intent === pi).map((r) => ({ object: "refund", id: r.id, amount: r.amount, status: r.status, payment_intent: r.payment_intent })) });
    }
    if (u.pathname === "/v1/refunds" && method === "POST") {
      if (key && state.refundKeys.has(key)) return json(state.refunds.find((r) => r.id === state.refundKeys.get(key)));
      if (state.failRefunds) return json({ error: { type: "api_error", message: "refunds down" } }, 503);
      const pi = form.payment_intent;
      const paid = [...state.sessions.values()].find((x) => x.account === account && x.payment_intent === pi);
      if (!paid) return noSuch("payment_intent");
      const r: FakeRefund = { id: `re_${Math.random().toString(36).slice(2, 12)}`, account, payment_intent: pi, amount: paid.amount_total, status: "succeeded", idempotencyKey: key };
      state.refunds.push(r);
      if (key) state.refundKeys.set(key, r.id);
      return json({ object: "refund", id: r.id, amount: r.amount, status: r.status, payment_intent: pi });
    }
    return json({ error: { type: "invalid_request_error", message: `fake Stripe has no ${method} ${u.pathname}` } }, 404);
  }) as unknown as typeof fetch;

  /** The guest finishes Checkout: the session completes and a PaymentIntent exists on the host's account. */
  const pay = (sessionId: string) => {
    const x = state.sessions.get(sessionId)!;
    x.status = "complete";
    x.payment_status = "paid";
    x.payment_intent = `pi_test_${Math.random().toString(36).slice(2, 14)}`;
    return x;
  };
  /** Stripe expires the session (its expires_at passed) with nothing paid. */
  const expire = (sessionId: string) => {
    state.sessions.get(sessionId)!.status = "expired";
  };
  /** A connected account that has finished onboarding. */
  const activeAccount = (country = "US") => {
    const a: FakeStripeAccount = {
      id: `acct_ready${Math.random().toString(36).slice(2, 10)}`, country, currency: CURRENCY[country] ?? "usd", livemode: false, cardPayments: "active", email: "host@example.com",
    };
    state.accounts.set(a.id, a);
    return a;
  };

  return { state, fetchImpl, pay, expire, activeAccount };
}
