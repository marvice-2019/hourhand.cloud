import type pg from "pg";
import { PRICES } from "../billing/plans";
import { hostLocaleOf } from "../i18n/host";
import { makeHostI18n } from "../i18n/host/format";
import { RAZORPAY_REFERRAL_DISCOUNT_INR } from "./credits";
import { renderReferralRewardMail, type RenderedMail } from "../mail/templates";

/** The queued "free month" email for one side of a referral; skipped if the credit no longer exists. */
export async function renderReferralReward(pool: Pick<pg.Pool, "query">, c: { dedupe_key: string; user_id: string }, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  const m = /^referral:([0-9a-f-]{36}):(referrer|referred)$/.exec(c.dedupe_key);
  if (!m) return { skip: "not a referral email" };
  const role = m[2] as "referrer" | "referred";
  const { rows: [r] } = await pool.query(
    `select other.name as other_name, s.provider, me.host_locale from referral_credits k join referrals r on r.id = k.referral_id
       join users other on other.id = case when k.role = 'referrer' then r.referred_id else r.referrer_id end
       join users me on me.id = k.user_id
       left join subscriptions s on s.user_id = k.user_id
      where k.referral_id = $1 and k.role = $2 and k.user_id = $3`, [m[1], role, c.user_id]);
  if (!r) return { skip: "free month no longer exists" };
  const hostLocale = hostLocaleOf({ hostLocale: r.host_locale });
  const fmt = makeHostI18n(hostLocale);
  const value = r.provider === "stripe" ? fmt.money(PRICES.solo.month.USD, "USD") : fmt.inr(RAZORPAY_REFERRAL_DISCOUNT_INR);
  return renderReferralRewardMail({ role, otherName: r.other_name, value, planUrl: `${baseUrl}/dashboard/referrals`, hostLocale });
}
