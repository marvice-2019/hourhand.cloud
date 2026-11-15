import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DomainForm } from "@/components/DomainForm";
import { authEnabled } from "@/lib/auth/auth";
import { hostPlan } from "@/lib/billing/account";
import { getAddon } from "@/lib/billing/addons";
import { billingFor } from "@/lib/billing/env";
import { addonLive, addonPriceId, addonPriceLine } from "@/lib/billing/plans";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { systemResolver } from "@/lib/domains/dns";
import { mayUseCustomDomain } from "@/lib/domains/service";
import { getDomain, type CustomDomain } from "@/lib/domains/store";
import { traefikFromEnv } from "@/lib/domains/traefik";
import { DOMAIN_TARGET } from "@/lib/domains/validate";
import Link from "next/link";
import { buyDomainAddon, cancelDomainAddon, checkDomainNow, removeDomainAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<CustomDomain["status"], { label: string; tone: string; detail: string }> = {
  pending: { label: "Waiting for DNS", tone: "text-text-muted", detail: "Add the record below. We check every few minutes; DNS changes can take up to an hour to show." },
  active: { label: "Active", tone: "text-success", detail: "Guests can book you at this address." },
  failed: { label: "Not working", tone: "text-danger", detail: "Guests are sent to your Hourhand page until this is fixed." },
};

/** domains.hourhand.cloud's IPv4 addresses, for hosts whose DNS provider can't put a CNAME on a root domain. */
async function targetIps(): Promise<string[]> {
  try {
    return await systemResolver(2_000).resolve4(DOMAIN_TARGET);
  } catch {
    return [];
  }
}

const ERRORS: Record<string, string> = {
  not_set_up: "Custom domains are not set up on this server yet.",
  needs_plan: "The custom domain add-on needs a Solo or Duo plan first.",
  already_subscribed: "You already have the custom domain add-on.",
  not_configured: "Payments for the custom domain add-on aren't set up on this server yet.",
  no_subscription: "There's no add-on to cancel.",
  provider: "The payment provider didn't accept that. Try again in a minute; nothing was charged.",
};

export default async function DomainPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const live = authEnabled();
  const pool = live ? getPool(process.env.DATABASE_URL as string) : null;
  const domain = pool ? await getDomain(pool, user.id) : null;
  const allowed = pool ? await mayUseCustomDomain(pool, user.id) : false;
  const paidPlan = pool ? (await hostPlan(pool, user.id)) !== "free" : false;
  const addon = pool ? await getAddon(pool, user.id, "domain") : null;
  const addonOn = addonLive(addon);
  const tls = traefikFromEnv();
  const canBuy = live && tls.ok && billingFor("razorpay") !== null && addonPriceId("domain") !== null;
  const ips = await targetIps();
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: user.timezone }).format(d);
  const status = domain ? STATUS[domain.status] : null;

  return (
    <div>
      <h1 className="font-display text-xl text-text">Custom domain</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Let guests book you at your own address, like <span className="font-semibold text-text">book.yourname.com</span>, instead of hourhand.cloud/{user.slug}.
      </p>

      {params.saved && <p role="status" className="mt-4 text-success">Domain saved. Now add the DNS record below.</p>}
      {params.checked && <p role="status" className="mt-4 text-text-muted">Checked just now.</p>}
      {params.removed && <p role="status" className="mt-4 text-text-muted">Domain removed. Guests who use it are sent to your Hourhand page.</p>}

      {live && !tls.ok && (
        <p role="status" className="mt-4 max-w-xl text-text-muted">Custom domains are not set up on this server yet, so they can&apos;t be bought or added. Your Hourhand page works as usual.</p>
      )}
      {!live && <p className="mt-6 text-text-muted">The demo data can&apos;t use a custom domain. Sign in with the database set up.</p>}

      {params.checkout === "done" && (
        <p role="status" className="mt-4 max-w-xl text-success">Checkout finished. The add-on switches on as soon as Razorpay confirms the payment, usually within a minute. Refresh to see it.</p>
      )}
      {params.checkout === "cancelled" && <p role="status" className="mt-4 text-text-muted">Checkout closed. Nothing was charged.</p>}
      {params.done === "cancelled" && <p role="status" className="mt-4 max-w-xl text-success">Add-on cancelled. Your domain keeps working until the end of the month you paid for.</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{(Object.hasOwn(ERRORS, params.error) && ERRORS[params.error]) || ERRORS.provider}</p>}

      {live && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">Custom domain add-on</h2>
          <p className="mt-1 text-text">{addonPriceLine("domain")}</p>
          {addonOn && addon ? (
            <>
              <p className="mt-1 text-text-muted">
                {addon.cancelAtPeriodEnd
                  ? `Cancelled. Your domain keeps working until ${addon.currentPeriodEnd ? fmt(addon.currentPeriodEnd) : "the end of this month"}, then guests go to hourhand.cloud/${user.slug}.`
                  : `Active${addon.currentPeriodEnd ? `, renews ${fmt(addon.currentPeriodEnd)}` : ""}.`}
                {!paidPlan && " Your plan is no longer paid, so your domain is off until you choose Solo or Duo again."}
              </p>
              {!addon.cancelAtPeriodEnd && (
                <form action={cancelDomainAddon} className="mt-4"><Button type="submit" variant="secondary" size="sm">Cancel add-on</Button></form>
              )}
            </>
          ) : !paidPlan ? (
            <>
              <p className="mt-1 text-text-muted">Available on Solo and Duo, on top of your plan.</p>
              <Link href="/dashboard/plan" className="mt-3 inline-block font-semibold text-accent underline">See plans</Link>
            </>
          ) : canBuy ? (
            <>
              <p className="mt-1 text-text-muted">Monthly, paid through Razorpay. Cancel any time; it runs to the end of the month you paid for.</p>
              <form action={buyDomainAddon} className="mt-4"><Button type="submit">Add custom domain</Button></form>
            </>
          ) : (
            <p className="mt-1 text-text-muted">{tls.ok ? ERRORS.not_configured : ERRORS.not_set_up}</p>
          )}
        </Card>
      )}

      {domain && status && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text break-all">{domain.domain}</h2>
          <p className={`mt-1 font-semibold ${status.tone}`}>{status.label}</p>
          <p className="mt-1 text-text-muted">{status.detail}</p>
          {domain.status === "active" && !allowed && (
            <p className="mt-1 text-danger">Off: the add-on or your paid plan has ended, so guests are sent to hourhand.cloud/{user.slug}.</p>
          )}
          {domain.lastError && <p role="alert" className="mt-2 text-danger">{domain.lastError}</p>}
          <p className="mt-2 text-sm text-text-muted">
            {domain.lastCheckedAt ? `Last checked ${fmt(domain.lastCheckedAt)}.` : "Not checked yet."}
            {domain.verifiedAt ? ` Verified ${fmt(domain.verifiedAt)}.` : ""}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={checkDomainNow}><Button type="submit" variant="secondary" size="sm">Check now</Button></form>
            <form action={removeDomainAction}><Button type="submit" variant="ghost" size="sm">Remove domain</Button></form>
          </div>
        </Card>
      )}

      {domain && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">The DNS record to add</h2>
          <p className="mt-1 text-text-muted">Where you bought the domain (GoDaddy, Hostinger, Namecheap, Cloudflare…), open its DNS settings and add:</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">Type</dt><dd className="font-mono text-text">CNAME</dd>
            <dt className="text-text-muted">Name</dt><dd className="font-mono text-text break-all">{domain.domain}</dd>
            <dt className="text-text-muted">Value</dt><dd className="font-mono text-text">{DOMAIN_TARGET}</dd>
          </dl>
          <p className="mt-3 text-sm text-text-muted">
            Many DNS panels want only the first part in Name: for <span className="font-mono">book.yourname.com</span>, type <span className="font-mono">book</span>.
            If you use Cloudflare, set the record to &quot;DNS only&quot; (grey cloud).
          </p>
          {ips.length > 0 && (
            <p className="mt-2 text-sm text-text-muted">
              Using your root domain (yourname.com) and your DNS provider won&apos;t allow a CNAME there? Add an A record to{" "}
              <span className="font-mono text-text">{ips.join(", ")}</span> instead.
            </p>
          )}
        </Card>
      )}

      {live && allowed && tls.ok && (
        <Card className="mt-6 max-w-2xl">
          <DomainForm current={domain?.domain} />
        </Card>
      )}
    </div>
  );
}
