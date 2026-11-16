import { Card } from "@/components/ui/Card";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { formatMoney, PRICES } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { YEARLY_REWARD_CAP } from "@/lib/referrals/codes";
import { RAZORPAY_REFERRAL_DISCOUNT_INR } from "@/lib/referrals/credits";
import { getOrCreateCode, referralSummary, type CreditLine } from "@/lib/referrals/store";

export const dynamic = "force-dynamic";

const STATUS: Record<CreditLine["status"], string> = {
  pending: "Waiting: comes off your first renewal on a paid plan",
  scheduled: "Comes off your next renewal",
  used: "Used on a renewal",
  extension: "Added as a month of Solo after your paid plan ends (UPI AutoPay and eMandate renewals can't be discounted)",
  failed: "Couldn't be applied automatically. Write to support and we'll sort it out",
};

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const value = `${formatMoney(RAZORPAY_REFERRAL_DISCOUNT_INR, "INR")} / ${formatMoney(PRICES.solo.month.USD, "USD")}`;

  if (!authEnabled()) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">Referrals</h1>
        <p className="mt-2 max-w-xl text-text-muted">Referral links need the database. Start the app with HOURHAND_DATA=postgres.</p>
      </div>
    );
  }
  const pool = getPool(process.env.DATABASE_URL as string);
  const code = await getOrCreateCode(pool, user.id);
  const link = `${(resolveBaseUrl() ?? "https://hourhand.cloud").replace(/\/+$/, "")}/r/${code}`;
  const { counts, credits, rewardedLastYear } = await referralSummary(pool, user.id);
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: user.timezone }).format(d);

  const stats: [string, number][] = [["Invited", counts.invited], ["Signed up", counts.signedUp], ["Paid", counts.paid], ["Free months earned", counts.credited]];

  return (
    <div>
      <h1 className="font-display text-xl text-text">Referrals</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Share your link. When someone signs up through it and starts paying for Solo or Duo, you both get a free month of Solo ({value}):
        yours comes off your next renewal, theirs off their next one.
      </p>
      {params.own === "1" && <p role="status" className="mt-4 max-w-xl text-text-muted">That&apos;s your own link. Share it with someone else; signing up through it yourself doesn&apos;t count.</p>}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">Your link</h2>
        <label htmlFor="referral-link" className="sr-only">Your referral link</label>
        <input id="referral-link" readOnly value={link} className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text" />
        <p className="mt-2 text-sm text-text-muted">The link works for 30 days after someone opens it.</p>
      </Card>

      <dl className="mt-6 grid max-w-2xl grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map(([label, n]) => (
          <Card key={label}>
            <dt className="text-sm text-text-muted">{label}</dt>
            <dd className="mt-1 font-display text-2xl text-text">{n}</dd>
          </Card>
        ))}
      </dl>
      {rewardedLastYear >= YEARLY_REWARD_CAP && (
        <p className="mt-4 max-w-xl text-sm text-text-muted">You&apos;ve earned the most free months allowed in 12 months ({YEARLY_REWARD_CAP}). People you invite still get theirs.</p>
      )}

      {credits.length > 0 && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">Your free months</h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {credits.map((c, i) => (
              <li key={i} className="text-text-muted">
                <span className="text-text">{c.role === "referrer" ? "For a referral" : "For joining through a link"}</span>, {fmt(c.createdAt)}: {STATUS[c.status]}
                {c.accessUntil ? `, until ${fmt(c.accessUntil)}` : ""}.
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 max-w-2xl text-sm text-text-muted">
        <h2 className="font-semibold text-text">The rules</h2>
        <ul className="mt-2 grid list-disc gap-1 pl-5">
          <li>The free months arrive after their first payment for Solo or Duo goes through, not when they sign up.</li>
          <li>Up to {YEARLY_REWARD_CAP} free months for referrals in any 12 months.</li>
          <li>Only new accounts count, and signing yourself up again doesn&apos;t: not with the same email, the same card, or the same browser.</li>
          <li>Free months come off a renewal. They can&apos;t be exchanged for cash.</li>
        </ul>
      </div>
    </div>
  );
}
