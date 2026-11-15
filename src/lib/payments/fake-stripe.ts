// Test-only: an in-memory Stripe for the Connect calls Hourhand makes, served through an injected fetch (the same pattern
// as the fake Razorpay in booking-payments.test.ts). Never imported by app code.

export interface FakeStripeAccount {
  id: string; country: string; currency: string; livemode: boolean; cardPayments: "active" | "pending" | "restricted" | "unsupported"; email: string;
}

export function fakeStripe() {
  const state = {
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
    return json({ error: { type: "invalid_request_error", message: `fake Stripe has no ${method} ${u.pathname}` } }, 404);
  }) as unknown as typeof fetch;

  return { state, fetchImpl };
}
