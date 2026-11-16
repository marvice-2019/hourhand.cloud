import { notFound } from "next/navigation";
import { BookingFooter } from "@/components/BookingFooter";
import { PackageCheckout } from "@/components/PackageCheckout";
import { authEnabled } from "@/lib/auth/auth";
import { formatAmount } from "@/lib/money";
import { getPool } from "@/lib/data/pg-store";
import { publicPackage } from "@/lib/packages/packages";
import { CampaignBanner } from "@/components/CampaignBanner";
import { hostPlan } from "@/lib/billing/account";
import { pagePricing } from "@/lib/offers/offers";

export const dynamic = "force-dynamic";

export default async function BuyPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const found = pool ? await publicPackage(pool, id) : null;
  if (!pool || !found) notFound();
  const { pkg, host, eventType } = found;
  const pricing = await pagePricing(pool, host.id, await hostPlan(pool, host.id), { kind: "package", id: pkg.id, listMinor: pkg.priceMinor, currency: pkg.currency }, new Date());
  const price = formatAmount(pricing.campaign?.chargeMinor ?? pkg.priceMinor, pkg.currency);
  const each = formatAmount(Math.round((pricing.campaign?.chargeMinor ?? pkg.priceMinor) / pkg.sessions), pkg.currency);
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">{pkg.name}</h1>
      {pricing.campaign && <CampaignBanner name={pricing.campaign.name} banner={pricing.campaign.banner} />}
      <p className="mt-2 text-text">
        {pkg.sessions} × {eventType.name} ({eventType.durationMinutes} min) for {pricing.campaign ? <><s>{formatAmount(pkg.priceMinor, pkg.currency)}</s> {price} with {pricing.campaign.name}</> : price}, about {each} a session.
      </p>
      <p className="mt-1 text-text-muted">Book them whenever suits you within {pkg.validDays} days of paying. Cancel a session in time and you get it back.</p>
      <PackageCheckout packageId={pkg.id} price={price} hostName={host.name} packageName={pkg.name} coupons={pricing.coupons} />
      <BookingFooter hostId={host.id} />
    </main>
  );
}
