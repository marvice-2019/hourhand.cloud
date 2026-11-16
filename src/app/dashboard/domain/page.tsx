import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DomainForm } from "@/components/DomainForm";
import { authEnabled } from "@/lib/auth/auth";
import { hostPlan } from "@/lib/billing/account";
import { getAddon } from "@/lib/billing/addons";
import { billingFor } from "@/lib/billing/env";
import { ADDON_PRICES, addonLive, addonPriceId, GST_RATE } from "@/lib/billing/plans";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { DNS_MESSAGES, systemResolver } from "@/lib/domains/dns";
import { mayUseCustomDomain } from "@/lib/domains/service";
import { getDomain, type CustomDomain } from "@/lib/domains/store";
import { traefikFromEnv } from "@/lib/domains/traefik";
import { DOMAIN_TARGET } from "@/lib/domains/validate";
import type { HostKey } from "@/lib/i18n/host";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";
import Link from "next/link";
import { buyDomainAddon, cancelDomainAddon, checkDomainNow, removeDomainAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<CustomDomain["status"], { label: HostKey; tone: string; detail: HostKey }> = {
  pending: { label: "domain.statusPending", tone: "text-text-muted", detail: "domain.statusPendingDetail" },
  active: { label: "domain.statusActive", tone: "text-success", detail: "domain.statusActiveDetail" },
  failed: { label: "domain.statusFailed", tone: "text-danger", detail: "domain.statusFailedDetail" },
};

// The DNS check stores its reason in English as the domain's last error; it is shown in the host's language.
const sayDns = translator(DNS_MESSAGES, {
  ourRecordMissing: "domain.dnsOurRecordMissing",
  ourLookupFailed: "domain.dnsOurLookupFailed",
  lookupFailed: "domain.dnsLookupFailed",
  cnameElsewhere: "domain.dnsCnameElsewhere",
  aElsewhere: "domain.dnsAElsewhere",
  noRecord: "domain.dnsNoRecord",
});

/** domains.hourhand.cloud's IPv4 addresses, for hosts whose DNS provider can't put a CNAME on a root domain. */
async function targetIps(): Promise<string[]> {
  try {
    return await systemResolver(2_000).resolve4(DOMAIN_TARGET);
  } catch {
    return [];
  }
}

const ERRORS: Record<string, HostKey> = {
  not_set_up: "domain.errorNotSetUp",
  needs_plan: "domain.addonErrorNeedsPlan",
  already_subscribed: "domain.addonErrorAlreadySubscribed",
  not_configured: "domain.addonErrorNotConfigured",
  no_subscription: "domain.addonErrorNoSubscription",
  provider: "domain.addonErrorProvider",
};

export default async function DomainPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const { t, tNodes, inr, mediumDateTime } = await getHostI18n();
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
  const fmt = (d: Date) => mediumDateTime(d, user.timezone);
  const addonBase = ADDON_PRICES.domain.month.INR;
  const status = domain ? STATUS[domain.status] : null;

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("domain.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {tNodes("domain.intro", { example: <span className="font-semibold text-text">{t("domain.exampleDomain")}</span>, slug: user.slug })}
      </p>

      {params.saved && <p role="status" className="mt-4 text-success">{t("domain.saved")}</p>}
      {params.checked && <p role="status" className="mt-4 text-text-muted">{t("domain.checked")}</p>}
      {params.removed && <p role="status" className="mt-4 text-text-muted">{t("domain.removed")}</p>}

      {live && !tls.ok && (
        <p role="status" className="mt-4 max-w-xl text-text-muted">{t("domain.tlsNotSetUp")}</p>
      )}
      {!live && <p className="mt-6 text-text-muted">{t("domain.demo")}</p>}

      {params.checkout === "done" && (
        <p role="status" className="mt-4 max-w-xl text-success">{t("domain.checkoutDone")}</p>
      )}
      {params.checkout === "cancelled" && <p role="status" className="mt-4 text-text-muted">{t("domain.checkoutCancelled")}</p>}
      {params.done === "cancelled" && <p role="status" className="mt-4 max-w-xl text-success">{t("domain.addonCancelledNotice")}</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(ERRORS, params.error) && ERRORS[params.error]) || ERRORS.provider)}</p>}

      {live && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">{t("domain.addonTitle")}</h2>
          <p className="mt-1 text-text">{t("domain.addonPrice", { base: inr(addonBase), total: inr(Math.round(addonBase * (1 + GST_RATE))) })}</p>
          {addonOn && addon ? (
            <>
              <p className="mt-1 text-text-muted">
                {addon.cancelAtPeriodEnd
                  ? addon.currentPeriodEnd
                    ? t("domain.addonCancelledUntil", { when: fmt(addon.currentPeriodEnd), slug: user.slug })
                    : t("domain.addonCancelledMonthEnd", { slug: user.slug })
                  : addon.currentPeriodEnd
                    ? t("domain.addonActiveRenews", { when: fmt(addon.currentPeriodEnd) })
                    : t("domain.addonActive")}
                {!paidPlan && ` ${t("domain.addonPlanLapsed")}`}
              </p>
              {!addon.cancelAtPeriodEnd && (
                <form action={cancelDomainAddon} className="mt-4"><Button type="submit" variant="secondary" size="sm">{t("domain.addonCancel")}</Button></form>
              )}
            </>
          ) : !paidPlan ? (
            <>
              <p className="mt-1 text-text-muted">{t("domain.addonPaidOnly")}</p>
              <Link href="/dashboard/plan" className="mt-3 inline-block font-semibold text-accent underline">{t("domain.seePlans")}</Link>
            </>
          ) : canBuy ? (
            <>
              <p className="mt-1 text-text-muted">{t("domain.addonBuyNote")}</p>
              <form action={buyDomainAddon} className="mt-4"><Button type="submit">{t("domain.addonBuy")}</Button></form>
            </>
          ) : (
            <p className="mt-1 text-text-muted">{t(tls.ok ? ERRORS.not_configured : ERRORS.not_set_up)}</p>
          )}
        </Card>
      )}

      {domain && status && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text break-all">{domain.domain}</h2>
          <p className={`mt-1 font-semibold ${status.tone}`}>{t(status.label)}</p>
          <p className="mt-1 text-text-muted">{t(status.detail)}</p>
          {domain.status === "active" && !allowed && (
            <p className="mt-1 text-danger">{t("domain.addonOff", { slug: user.slug })}</p>
          )}
          {domain.lastError && <p role="alert" className="mt-2 text-danger">{sayDns(t, domain.lastError)}</p>}
          <p className="mt-2 text-sm text-text-muted">
            {domain.lastCheckedAt ? t("domain.lastChecked", { when: fmt(domain.lastCheckedAt) }) : t("domain.notChecked")}
            {domain.verifiedAt ? ` ${t("domain.verified", { when: fmt(domain.verifiedAt) })}` : ""}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={checkDomainNow}><Button type="submit" variant="secondary" size="sm">{t("domain.checkNow")}</Button></form>
            <form action={removeDomainAction}><Button type="submit" variant="ghost" size="sm">{t("domain.remove")}</Button></form>
          </div>
        </Card>
      )}

      {domain && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">{t("domain.recordTitle")}</h2>
          <p className="mt-1 text-text-muted">{t("domain.recordIntro")}</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">{t("domain.recordType")}</dt>
            <dd className="font-mono text-text">CNAME</dd>{/* i18n-ignore: the DNS record type */}
            <dt className="text-text-muted">{t("domain.recordName")}</dt><dd className="font-mono text-text break-all">{domain.domain}</dd>
            <dt className="text-text-muted">{t("domain.recordValue")}</dt><dd className="font-mono text-text">{DOMAIN_TARGET}</dd>
          </dl>
          <p className="mt-3 text-sm text-text-muted">
            {tNodes("domain.nameTip", {
              example: <span className="font-mono">{t("domain.exampleDomain")}</span>,
              sub: <span className="font-mono">{t("domain.exampleSub")}</span>,
            })}{" "}
            {t("domain.cloudflareTip")}
          </p>
          {ips.length > 0 && (
            <p className="mt-2 text-sm text-text-muted">
              {tNodes("domain.rootTip", { ips: <span className="font-mono text-text">{ips.join(", ")}</span> })}
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
