import Link from "next/link";
import { removeSlidingAction, toggleOffer } from "./actions";
import { CampaignForm, CouponForm, FirstSessionForm, SlidingForm } from "@/components/OfferForms";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { formatMoney, LIMITS } from "@/lib/billing/plans";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { dayKey, formatDate } from "@/lib/format";
import { getFirstSession, listCampaigns, listCoupons, listSlidingScales } from "@/lib/offers/manage";
import { campaignLive, describeDiscount } from "@/lib/offers/pricing";
import { listMembershipPlans } from "@/lib/memberships/memberships";
import { listPackages } from "@/lib/packages/packages";

export const dynamic = "force-dynamic";

const rupees = (minor: number) => String(minor / 100);

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireHost();
  const { error } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const plan = db ? await hostPlan(db, user.id) : "free";
  const now = new Date();
  const today = dayKey(now, user.timezone);
  const [eventTypes, packages, membershipPlans, coupons, campaigns, first, sliding] = await Promise.all([
    store.listEventTypes(user.id), db ? listPackages(db, user.id) : [], db ? listMembershipPlans(db, user.id) : [], db ? listCoupons(db, user.id, now) : [], db ? listCampaigns(db, user.id) : [],
    db ? getFirstSession(db, user.id) : null, db ? listSlidingScales(db, user.id) : new Map(),
  ]);
  const paid = eventTypes.filter((e) => e.priceMinor !== null).map(({ id, name, priceMinor }) => ({ id, name, priceMinor: priceMinor! }));
  const pkgs = packages.filter((p) => p.active).map(({ id, name }) => ({ id, name }));
  const plans = membershipPlans.filter((m) => m.active).map(({ id, name }) => ({ id, name }));
  const names = new Map<string, string>([
    ...eventTypes.map((e) => [e.id, e.name] as const), ...packages.map((p) => [p.id, `${p.name} (package)`] as const),
    ...membershipPlans.map((m) => [m.id, `${m.name} (membership, first month)`] as const),
  ]);
  const forWhat = (o: { eventTypeIds: string[]; packageIds: string[]; membershipPlanIds: string[] }) => {
    const all = [...o.eventTypeIds, ...o.packageIds, ...o.membershipPlanIds];
    return all.length === 0 ? "everything you sell (a membership's first month only)" : all.map((id) => names.get(id) ?? "removed").join(", ");
  };

  if (!LIMITS[plan].offers) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">Offers</h1>
        <p className="mt-2 max-w-xl text-text-muted">
          Discount codes, a first-session discount for new clients, pay-what-you-can pricing and dated campaigns like a Diwali offer.
          They come with the Solo and Duo plans.
        </p>
        <Link href="/dashboard/plan" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">See plans</Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-display text-xl text-text">Offers</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Each booking, package or membership sign-up gets at most one offer: whichever gives the client the best price. GST is worked out on the price after the
        discount, and the invoice shows the discount. A code use counts only once the payment goes through.
      </p>
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">That offer isn&apos;t yours, or no longer exists.</p>}
      {paid.length === 0 && <p className="mt-4 max-w-xl rounded-md bg-surface p-3 text-text">Offers apply to priced event types and packages. Set a price on an event type first.</p>}

      <section aria-labelledby="of-codes" className="mt-8">
        <h2 id="of-codes" className="font-semibold text-text">Discount codes</h2>
        <Card className="mt-3 max-w-xl"><CouponForm eventTypes={paid} packages={pkgs} plans={plans} /></Card>
        {coupons.length > 0 && (
          <ul className="mt-4 grid max-w-xl gap-3">
            {coupons.map((c) => (
              <li key={c.id}>
                <Card className="grid gap-2">
                  <p className="font-semibold text-text">{c.code} {!c.active && <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">Off</span>}</p>
                  <p className="text-sm text-text-muted">
                    {describeDiscount(c.discount)} · {forWhat(c)}
                    {c.expiresAt && ` · until ${formatDate(new Date(c.expiresAt.getTime() - 1), user.timezone)}`}
                  </p>
                  <p className="text-sm text-text">
                    Used {c.used}{c.maxUses !== null && ` of ${c.maxUses}`}{c.reserved > 0 && `, ${c.reserved} in checkout now`}
                    {c.maxUsesPerEmail !== null && ` · ${c.maxUsesPerEmail} per client`}
                  </p>
                  <form action={toggleOffer}>
                    <input type="hidden" name="what" value="coupon" /><input type="hidden" name="id" value={c.id} />
                    {!c.active && <input type="hidden" name="active" value="on" />}
                    <Button type="submit" variant="ghost" size="sm">{c.active ? "Switch off" : "Switch on"}</Button>
                  </form>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="of-first" className="mt-8">
        <h2 id="of-first" className="font-semibold text-text">First-session discount</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">Automatic for a client email that has never paid you for a session (bookings, not packages).</p>
        <Card className="mt-3 max-w-xl">
          <FirstSessionForm current={first && { kind: first.kind, value: first.kind === "percent" ? String(first.value) : rupees(first.value), active: first.active }} />
        </Card>
      </section>

      <section aria-labelledby="of-camp" className="mt-8">
        <h2 id="of-camp" className="font-semibold text-text">Campaigns</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">A dated offer with a banner on your booking page. It switches itself on and off by date in your time zone ({user.timezone}).</p>
        <Card className="mt-3 max-w-xl"><CampaignForm eventTypes={paid} packages={pkgs} plans={plans} today={today} /></Card>
        {campaigns.length > 0 && (
          <ul className="mt-4 grid max-w-xl gap-3">
            {campaigns.map((c) => {
              const state = !c.active ? "Off" : campaignLive(c, now, user.timezone) ? "Live now" : c.endsOn < today ? "Ended" : "Scheduled";
              return (
                <li key={c.id}>
                  <Card className="grid gap-2">
                    <p className="font-semibold text-text">{c.name} <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">{state}</span></p>
                    <p className="text-sm text-text">{c.banner}</p>
                    <p className="text-sm text-text-muted">{describeDiscount(c.discount)} · {c.startsOn} to {c.endsOn} · {forWhat(c)}</p>
                    <form action={toggleOffer}>
                      <input type="hidden" name="what" value="campaign" /><input type="hidden" name="id" value={c.id} />
                      {!c.active && <input type="hidden" name="active" value="on" />}
                      <Button type="submit" variant="ghost" size="sm">{c.active ? "Switch off" : "Switch on"}</Button>
                    </form>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="of-slide" className="mt-8">
        <h2 id="of-slide" className="font-semibold text-text">Pay what you can</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">
          Clients pick an amount in your range, with your explanation beside it. It replaces the price, so codes, campaigns and the first-session discount don&apos;t apply on top.
        </p>
        <ul className="mt-3 grid max-w-xl gap-3">
          {paid.map((e) => {
            const s = sliding.get(e.id);
            return (
              <li key={e.id}>
                <Card className="grid gap-3">
                  <p className="font-semibold text-text">{e.name} <span className="font-normal text-text-muted">· listed at {formatMoney(e.priceMinor, "INR")}</span></p>
                  <SlidingForm eventTypeId={e.id} current={s ? { min: rupees(s.minMinor), suggested: rupees(s.suggestedMinor), max: rupees(s.maxMinor), note: s.note ?? "" } : null} />
                  {s && (
                    <form action={removeSlidingAction}>
                      <input type="hidden" name="eventTypeId" value={e.id} />
                      <Button type="submit" variant="ghost" size="sm">Back to the fixed price</Button>
                    </form>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
