import { Card } from "@/components/ui/Card";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { PRICES } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { YEARLY_REWARD_CAP } from "@/lib/referrals/codes";
import { RAZORPAY_REFERRAL_DISCOUNT_INR } from "@/lib/referrals/credits";
import { getOrCreateCode, referralSummary, type CreditLine } from "@/lib/referrals/store";

export const dynamic = "force-dynamic";

const STATUS: Record<CreditLine["status"], HostKey> = {
  pending: "referrals.statusPending",
  scheduled: "referrals.statusScheduled",
  used: "referrals.statusUsed",
  extension: "referrals.statusExtension",
  failed: "referrals.statusFailed",
};

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const { t, date, inr, money, number } = await getHostI18n();
  const value = `${inr(RAZORPAY_REFERRAL_DISCOUNT_INR)} / ${money(PRICES.solo.month.USD, "USD")}`; // i18n-ignore

  if (!authEnabled()) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">{t("referrals.title")}</h1>
        <p className="mt-2 max-w-xl text-text-muted">{t("referrals.needsDb")}</p>
      </div>
    );
  }
  const pool = getPool(process.env.DATABASE_URL as string);
  const code = await getOrCreateCode(pool, user.id);
  const link = `${(resolveBaseUrl() ?? "https://hourhand.cloud").replace(/\/+$/, "")}/r/${code}`;
  const { counts, credits, rewardedLastYear } = await referralSummary(pool, user.id);

  const stats: [HostKey, number][] = [
    ["referrals.invited", counts.invited], ["referrals.signedUp", counts.signedUp], ["referrals.paid", counts.paid], ["referrals.earned", counts.credited],
  ];
  const statusOf = (c: CreditLine) => {
    const s = t(c.missedRenewals > 0 && c.status !== "used" ? "referrals.statusMissed" : STATUS[c.status]);
    return c.accessUntil ? t("referrals.until", { status: s, date: date(c.accessUntil, user.timezone) }) : s;
  };

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("referrals.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("referrals.intro", { value })}</p>
      {params.own === "1" && <p role="status" className="mt-4 max-w-xl text-text-muted">{t("referrals.ownLink")}</p>}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("referrals.yourLink")}</h2>
        <label htmlFor="referral-link" className="sr-only">{t("referrals.linkLabel")}</label>
        <input id="referral-link" readOnly value={link} className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text" />
        <p className="mt-2 text-sm text-text-muted">{t("referrals.linkWindow")}</p>
      </Card>

      <dl className="mt-6 grid max-w-2xl grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map(([label, n]) => (
          <Card key={label}>
            <dt className="text-sm text-text-muted">{t(label)}</dt>
            <dd className="mt-1 font-display text-2xl text-text">{number(n)}</dd>
          </Card>
        ))}
      </dl>
      {rewardedLastYear >= YEARLY_REWARD_CAP && (
        <p className="mt-4 max-w-xl text-sm text-text-muted">{t("referrals.capReached", { n: number(YEARLY_REWARD_CAP) })}</p>
      )}

      {credits.length > 0 && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">{t("referrals.yourMonths")}</h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {credits.map((c, i) => (
              <li key={i} className="text-text-muted">
                {t(c.role === "referrer" ? "referrals.forReferral" : "referrals.forJoining", { date: date(c.createdAt, user.timezone), status: statusOf(c) })}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 max-w-2xl text-sm text-text-muted">
        <h2 className="font-semibold text-text">{t("referrals.rules")}</h2>
        <ul className="mt-2 grid list-disc gap-1 pl-5">
          <li>{t("referrals.ruleFirstPayment")}</li>
          <li>{t("referrals.ruleCap", { n: number(YEARLY_REWARD_CAP) })}</li>
          <li>{t("referrals.ruleSelf")}</li>
          <li>{t("referrals.ruleCash")}</li>
        </ul>
      </div>
    </div>
  );
}
