import type pg from "pg";
import { BillingApiError, send, type Fetch } from "../billing/providers";
import { seal, unseal } from "../crypto/seal";

// The host's own Stripe account, connected to Hourhand's Stripe platform (Stripe Connect). The host never pastes a key:
// Hourhand creates a connected account with the full Stripe Dashboard, where Stripe collects its own fees and owns
// losses (the Accounts v2 form of a Standard account), and sends the host to Stripe's hosted onboarding. Guests later
// pay that account directly (direct charges), so the money never passes through Marvice.
//
// Docs (read 2026-11-15): https://docs.stripe.com/api/v2/core/accounts/create.md,
// https://docs.stripe.com/api/v2/core/account-links/create.md, https://docs.stripe.com/api/v2/core/accounts/retrieve.md,
// https://docs.stripe.com/connect/accounts-v2/account-creation.md (new platforms use Accounts v2; OAuth "isn't
// recommended for new Connect platforms": https://docs.stripe.com/connect/oauth-standard-accounts.md).

type Db = Pick<pg.Pool, "query">;
type Env = Record<string, string | undefined>;

/** The Stripe API version every Connect call pins. v2 endpoints require one. */
export const STRIPE_API_VERSION = "2026-10-28.endive";

/**
 * Hourhand's cut of each guest payment, in basis points. Zero for now: the host keeps everything less Stripe's own fee.
 * Changing it is the only edit needed to start charging an application fee.
 */
export const APPLICATION_FEE_BP = 0;

/** The fee for an amount, in the same minor units. */
export const applicationFeeMinor = (amountMinor: number): number => Math.floor((amountMinor * APPLICATION_FEE_BP) / 10_000);

/**
 * Countries a host can open a Stripe account in from here. India is left out on purpose: Indian hosts use Razorpay
 * (INR, GST invoices). Stripe's own list is longer; these cover the markets Hourhand sells to.
 */
export const STRIPE_COUNTRIES: Record<string, string> = {
  US: "United States", GB: "United Kingdom", IE: "Ireland", CA: "Canada", AU: "Australia", NZ: "New Zealand",
  SG: "Singapore", AE: "United Arab Emirates", HK: "Hong Kong", MY: "Malaysia", JP: "Japan",
  DE: "Germany", FR: "France", NL: "Netherlands", BE: "Belgium", ES: "Spain", IT: "Italy", PT: "Portugal", AT: "Austria",
  CH: "Switzerland", SE: "Sweden", DK: "Denmark", NO: "Norway", FI: "Finland", PL: "Poland",
};

/** Where the host is in Stripe's onboarding: pending = not finished, restricted = Stripe needs more, active = can charge. */
export type StripeOnboarding = "pending" | "active" | "restricted";

export interface StripeAccount {
  id: string;
  livemode: boolean;
  /** The account's default (settlement) currency, upper case; null until Stripe sets it. Guests pay in this. */
  currency: string | null;
  country: string | null;
  onboarding: StripeOnboarding;
}

export interface StripeConnectApi {
  createAccount(p: { userId: string; email: string; displayName: string; country: string; idempotencyKey: string }): Promise<StripeAccount>;
  /** A single-use link into Stripe's hosted onboarding for the account. Never stored or sent outside the browser redirect. */
  onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  getAccount(accountId: string): Promise<StripeAccount>;
}

/** card_payments on the merchant configuration decides whether the host can take payments. */
export function onboardingFromCapability(status: unknown): StripeOnboarding {
  if (status === "active") return "active";
  if (status === "restricted" || status === "unsupported") return "restricted";
  return "pending";
}

const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;

function toAccount(a: Record<string, unknown>): StripeAccount {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const id = a.id;
  if (typeof id !== "string" || !ACCT.test(id)) throw new BillingApiError("Stripe returned no account id", null, false);
  const merchant = obj(obj(a.configuration).merchant);
  const card = obj(obj(merchant.capabilities).card_payments);
  const currency = obj(a.defaults).currency;
  const country = obj(a.identity).country;
  return {
    id, livemode: a.livemode === true,
    currency: typeof currency === "string" && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : null,
    country: typeof country === "string" && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : null,
    onboarding: onboardingFromCapability(card.status),
  };
}

const INCLUDE = ["configuration.merchant", "defaults", "identity"];

export function stripeConnectApi(opts: { secretKey: string; baseUrl?: string; fetchImpl?: Fetch }): StripeConnectApi {
  const base = (opts.baseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const headers = (extra: Record<string, string> = {}) =>
    ({ authorization: `Bearer ${opts.secretKey}`, "stripe-version": STRIPE_API_VERSION, ...extra });
  const post = (path: string, body: unknown, idempotencyKey?: string) =>
    send(f, `${base}${path}`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }),
      body: JSON.stringify(body),
    }, "Stripe");

  return {
    async createAccount(p) {
      const a = await post("/v2/core/accounts", {
        contact_email: p.email,
        display_name: p.displayName.slice(0, 100) || undefined,
        identity: { country: p.country.toLowerCase() },
        dashboard: "full",
        defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        metadata: { hourhand_user_id: p.userId },
        include: INCLUDE,
      }, p.idempotencyKey);
      return toAccount(a);
    },
    async onboardingLink(accountId, returnUrl, refreshUrl) {
      const l = await post("/v2/core/account_links", {
        account: accountId,
        use_case: { type: "account_onboarding", account_onboarding: { configurations: ["merchant"], return_url: returnUrl, refresh_url: refreshUrl } },
      });
      if (typeof l.url !== "string" || !l.url.startsWith("https://")) throw new BillingApiError("Stripe returned no onboarding link", null, false);
      return l.url;
    },
    async getAccount(accountId) {
      if (!ACCT.test(accountId)) throw new BillingApiError("Not a Stripe account id", null, false);
      const q = INCLUDE.map((v, i) => `include[${i}]=${encodeURIComponent(v)}`).join("&");
      return toAccount(await send(f, `${base}/v2/core/accounts/${accountId}?${q}`, { method: "GET", headers: headers() }, "Stripe"));
    },
  };
}

/** Test-only base URL, honoured outside production or in an end-to-end run (same rule as billing). */
export function stripeApiBase(env: Env = process.env): string | undefined {
  return env.NODE_ENV !== "production" || env.HOURHAND_E2E === "1" ? env.STRIPE_API_BASE_URL : undefined;
}

/**
 * The Connect platform, or null when this server can't take Stripe payments. Both the platform's secret key and the
 * signing secret of the "Connected accounts" webhook endpoint are needed: without that webhook no payment confirms.
 */
export function stripeConnectFromEnv(env: Env = process.env): { api: StripeConnectApi; secretKey: string; webhookSecret: string } | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  return { api: stripeConnectApi({ secretKey, baseUrl: stripeApiBase(env) }), secretKey, webhookSecret };
}

export type StripeConnectProblem = "other_provider" | "country" | "unreachable" | "busy" | "not_connected";

export class StripeConnectError extends Error {
  constructor(readonly code: StripeConnectProblem, message: string) {
    super(message);
    this.name = "StripeConnectError";
  }
}

const aad = (userId: string, accountId: string) => `stripe:${userId}:${accountId}`;

export interface HostStripe {
  accountId: string;
  onboarding: StripeOnboarding;
  currency: string | null;
  country: string | null;
  mode: "test" | "live";
}

interface Row { credentials_encrypted: Buffer; public_id: string; onboarding: StripeOnboarding; currency: string | null; country: string | null; mode: "test" | "live" }

const rowFor = async (db: Db, userId: string): Promise<Row | null> =>
  (await db.query("select credentials_encrypted, public_id, onboarding, currency, country, mode from integrations where user_id = $1 and provider = 'stripe' and status = 'ok'", [userId])).rows[0] ?? null;

/** The host's connected account, or null. Throws if the stored row was tampered with or moved to another host. */
export async function loadHostStripe(db: Db, key: Buffer, userId: string): Promise<HostStripe | null> {
  const r = await rowFor(db, userId);
  if (!r) return null;
  const sealed = unseal<{ accountId: string }>(key, r.credentials_encrypted, aad(userId, r.public_id));
  if (sealed.accountId !== r.public_id) throw new Error("Stored Stripe account doesn't match its seal");
  return { accountId: r.public_id, onboarding: r.onboarding, currency: r.currency, country: r.country, mode: r.mode };
}

/** Whether guests can pay this host through Stripe right now. */
export const stripeReady = (s: HostStripe | null): s is HostStripe & { currency: string } => s !== null && s.onboarding === "active" && s.currency !== null;

/**
 * What the integrations page shows, including an account whose owner removed Hourhand in Stripe (`removed`), so the host
 * can still disconnect it here and switch providers. No seal check: the page shows status, it doesn't act on the account.
 */
export async function stripeStatus(db: Db, userId: string): Promise<HostStripe & { removed: boolean } | null> {
  const { rows: [r] } = await db.query("select public_id, onboarding, currency, country, mode, status from integrations where user_id = $1 and provider = 'stripe'", [userId]);
  return r ? { accountId: r.public_id, onboarding: r.onboarding, currency: r.currency, country: r.country, mode: r.mode, removed: r.status !== "ok" } : null;
}

async function saveAccount(db: Db, key: Buffer, userId: string, a: StripeAccount): Promise<void> {
  try {
    await db.query(
      `insert into integrations (user_id, provider, credentials_encrypted, public_id, mode, status, onboarding, currency, country)
       values ($1, 'stripe', $2, $3, $4, 'ok', $5, $6, $7)
       on conflict (user_id, provider) do update set credentials_encrypted = excluded.credentials_encrypted, public_id = excluded.public_id,
         mode = excluded.mode, status = 'ok', onboarding = excluded.onboarding, currency = excluded.currency, country = excluded.country, updated_at = now()`,
      [userId, seal(key, { accountId: a.id }, aad(userId, a.id)), a.id, a.livemode ? "live" : "test", a.onboarding, a.currency, a.country]);
  } catch (error) {
    // The one-provider index: Razorpay was connected in the meantime.
    if ((error as { code?: string }).code === "23505") throw new StripeConnectError("other_provider", "Razorpay is connected. Disconnect it before connecting Stripe.");
    throw error;
  }
}

const unreachable = (error: unknown) =>
  new StripeConnectError("unreachable", `Couldn't reach Stripe: ${(error as Error).message}`);

/**
 * Step 1 of connecting: creates the host's connected account (or reuses the one already on file) and returns Stripe's
 * onboarding link to send them to. Refused while Razorpay is connected: one payment provider at a time.
 */
export async function startStripeConnect(
  db: Db, key: Buffer, api: StripeConnectApi,
  host: { id: string; email: string; name: string }, country: string | null, urls: { returnUrl: string; refreshUrl: string },
): Promise<string> {
  const { rows: other } = await db.query("select 1 from integrations where user_id = $1 and provider = 'razorpay'", [host.id]);
  if (other.length) throw new StripeConnectError("other_provider", "Razorpay is connected. Disconnect it before connecting Stripe.");
  let current = await loadHostStripe(db, key, host.id);
  if (!current) {
    const c = (country ?? "").toUpperCase();
    if (!Object.hasOwn(STRIPE_COUNTRIES, c)) throw new StripeConnectError("country", "Choose the country your business is registered in.");
    let account: StripeAccount;
    try {
      // The key makes a double click (or a retry after a timeout) return the same account instead of creating two.
      account = await api.createAccount({ userId: host.id, email: host.email, displayName: host.name, country: c, idempotencyKey: `hh-connect-${host.id}-${c}` });
    } catch (error) {
      throw unreachable(error);
    }
    await saveAccount(db, key, host.id, account);
    current = await loadHostStripe(db, key, host.id);
  }
  try {
    return await api.onboardingLink(current!.accountId, urls.returnUrl, urls.refreshUrl);
  } catch (error) {
    throw unreachable(error);
  }
}

/** Re-reads the host's account from Stripe and saves where onboarding stands. Called on return from Stripe and on account webhooks. */
export async function refreshStripeAccount(db: Db, key: Buffer, api: StripeConnectApi, userId: string): Promise<HostStripe | null> {
  const current = await loadHostStripe(db, key, userId);
  if (!current) return null;
  let a: StripeAccount;
  try {
    a = await api.getAccount(current.accountId);
  } catch (error) {
    throw unreachable(error);
  }
  await db.query(
    `update integrations set onboarding = $3, currency = coalesce($4, currency), country = coalesce($5, country), mode = $6, updated_at = now()
     where user_id = $1 and provider = 'stripe' and public_id = $2`,
    [userId, a.id, a.onboarding, a.currency, a.country, a.livemode ? "live" : "test"]);
  return loadHostStripe(db, key, userId);
}

/** The host a connected account belongs to, for webhooks. */
export async function hostForStripeAccount(db: Db, accountId: string): Promise<string | null> {
  const { rows } = await db.query("select user_id from integrations where provider = 'stripe' and public_id = $1", [accountId]);
  return rows[0]?.user_id ?? null;
}

/**
 * Forgets the host's Stripe account (their account itself stays theirs, in Stripe). Refused while a guest's payment is
 * still being confirmed or refunded through it: those need the account to finish, and dropping it would strand the money.
 */
export async function disconnectStripe(db: Db, userId: string): Promise<void> {
  const { rowCount } = await db.query(
    `delete from integrations where user_id = $1 and provider = 'stripe'
       and not exists (select 1 from payments where host_id = $1 and provider = 'stripe' and status in ('pending', 'refund_pending'))`, [userId]);
  if (rowCount) return;
  const { rows } = await db.query("select 1 from integrations where user_id = $1 and provider = 'stripe'", [userId]);
  if (rows.length) throw new StripeConnectError("busy", "A guest's payment is still being confirmed or refunded.");
}

/** acct_••••AbCd: enough for the host to recognise their account. */
export function maskAccountId(id: string): string {
  return ACCT.test(id) ? `acct_••••${id.slice(-4)}` : "••••";
}
