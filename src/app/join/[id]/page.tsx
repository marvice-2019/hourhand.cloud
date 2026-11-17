import { notFound } from "next/navigation";
import { BookingFooter } from "@/components/BookingFooter";
import { CampaignBanner } from "@/components/CampaignBanner";
import { MembershipJoin } from "@/components/MembershipJoin";
import { authEnabled } from "@/lib/auth/auth";
import { hostPlan } from "@/lib/billing/account";
import { formatMoney } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { publicMembershipPlan } from "@/lib/memberships/memberships";
import { pagePricing } from "@/lib/offers/offers";

export const dynamic = "force-dynamic";

const ROLLOVER_LINE = {
  none: "Sessions you don't book in a month don't carry over.",
  capped: (cap: number) => `Unused sessions carry over, up to ${cap} in total.`,
  unlimited: "Unused sessions carry over while you're a member.",
};

export default async function JoinMembershipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const found = pool ? await publicMembershipPlan(pool, id) : null;
  if (!pool || !found) notFound();
  const { plan, host, eventTypes } = found;
  // A code or campaign takes money off the first month only.
  const pricing = await pagePricing(pool, host.id, await hostPlan(pool, host.id), { kind: "membership", id: plan.id, listMinor: plan.priceMinor, currency: "INR" }, new Date());
  const campaignFirst = pricing.campaign ? formatMoney(pricing.campaign.chargeMinor, "INR") : null;
  const price = formatMoney(plan.priceMinor, "INR");
  const each = formatMoney(Math.round(plan.priceMinor / plan.sessions), "INR");
  const rollover = plan.rollover === "capped" ? ROLLOVER_LINE.capped(plan.rolloverCap!) : ROLLOVER_LINE[plan.rollover];
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">{plan.name}</h1>
      {pricing.campaign && <CampaignBanner name={pricing.campaign.name} banner={pricing.campaign.banner} />}
      <p className="mt-2 text-text">{plan.sessions} {plan.sessions === 1 ? "session" : "sessions"} a month for {price}, about {each} a session.</p>
      <p className="mt-1 text-text-muted">For {eventTypes.map((e) => `${e.name} (${e.durationMinutes} min)`).join(", ")}. {rollover} Cancel any time; you keep what you&apos;ve paid for until the month ends.</p>
      {campaignFirst && <p className="mt-1 font-semibold text-text">First month {campaignFirst} with {pricing.campaign!.name}, then {price} a month.</p>}
      <MembershipJoin planId={plan.id} price={price} firstPrice={campaignFirst} codes={pricing.coupons} hostName={host.name} planName={plan.name} />
      <BookingFooter hostId={host.id} />
    </main>
  );
}
