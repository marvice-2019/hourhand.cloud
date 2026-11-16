import Link from "next/link";
import { removeSlidingAction, toggleOffer } from "./actions";
import { CampaignForm, CouponForm, FirstSessionForm, SlidingForm } from "@/components/OfferForms";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { dayKey } from "@/lib/format";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";
import { getFirstSession, listCampaigns, listCoupons, listSlidingScales } from "@/lib/offers/manage";
import { campaignLive, describeDiscount, DISCOUNT_MESSAGES, type Discount } from "@/lib/offers/pricing";
import { listPackages } from "@/lib/packages/packages";

export const dynamic = "force-dynamic";

const rupees = (minor: number) => String(minor / 100);
const sayDiscount = translator(DISCOUNT_MESSAGES, { percent: "offers.percentOff", fixed: "offers.rupeesOff" });

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireHost();
  const { t, date, inr } = await getHostI18n();
  const off = (d: Discount) => sayDiscount(t, describeDiscount(d));
  const { error } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const plan = db ? await hostPlan(db, user.id) : "free";
  const now = new Date();
  const today = dayKey(now, user.timezone);
  const [eventTypes, packages, coupons, campaigns, first, sliding] = await Promise.all([
    store.listEventTypes(user.id), db ? listPackages(db, user.id) : [], db ? listCoupons(db, user.id, now) : [], db ? listCampaigns(db, user.id) : [],
    db ? getFirstSession(db, user.id) : null, db ? listSlidingScales(db, user.id) : new Map(),
  ]);
  const paid = eventTypes.filter((e) => e.priceMinor !== null).map(({ id, name, priceMinor }) => ({ id, name, priceMinor: priceMinor! }));
  const pkgs = packages.filter((p) => p.active).map(({ id, name }) => ({ id, name }));
  const names = new Map<string, string>([...eventTypes.map((e) => [e.id, e.name] as const), ...packages.map((p) => [p.id, t("offers.packageName", { name: p.name })] as const)]);
  const forWhat = (o: { eventTypeIds: string[]; packageIds: string[] }) =>
    o.eventTypeIds.length + o.packageIds.length === 0 ? t("offers.forEverything") : [...o.eventTypeIds, ...o.packageIds].map((id) => names.get(id) ?? t("offers.removedItem")).join(", ");

  const usage = (c: { used: number; maxUses: number | null; reserved: number; maxUsesPerEmail: number | null }) => {
    let line = c.maxUses !== null ? t("offers.usedOf", { used: c.used, max: c.maxUses }) : t("offers.used", { used: c.used });
    if (c.reserved > 0) line = t("offers.usedInCheckout", { uses: line, n: c.reserved });
    if (c.maxUsesPerEmail !== null) line = t("offers.usedPerClient", { uses: line, n: c.maxUsesPerEmail });
    return line;
  };

  if (!LIMITS[plan].offers) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">{t("offers.title")}</h1>
        <p className="mt-2 max-w-xl text-text-muted">{t("offers.needsPlan")}</p>
        <Link href="/dashboard/plan" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("offers.seePlans")}</Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("offers.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("offers.intro")}</p>
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("offers.errNotFound")}</p>}
      {paid.length === 0 && <p className="mt-4 max-w-xl rounded-md bg-surface p-3 text-text">{t("offers.noPaid")}</p>}

      <section aria-labelledby="of-codes" className="mt-8">
        <h2 id="of-codes" className="font-semibold text-text">{t("offers.codesTitle")}</h2>
        <Card className="mt-3 max-w-xl"><CouponForm eventTypes={paid} packages={pkgs} /></Card>
        {coupons.length > 0 && (
          <ul className="mt-4 grid max-w-xl gap-3">
            {coupons.map((c) => (
              <li key={c.id}>
                <Card className="grid gap-2">
                  <p className="font-semibold text-text">{c.code} {!c.active && <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">{t("offers.stateOff")}</span>}</p>
                  <p className="text-sm text-text-muted">
                    {c.expiresAt
                      ? t("offers.couponTermsUntil", { discount: off(c.discount), items: forWhat(c), date: date(new Date(c.expiresAt.getTime() - 1), user.timezone) })
                      : t("offers.couponTerms", { discount: off(c.discount), items: forWhat(c) })}
                  </p>
                  <p className="text-sm text-text">{usage(c)}</p>
                  <form action={toggleOffer}>
                    <input type="hidden" name="what" value="coupon" /><input type="hidden" name="id" value={c.id} />
                    {!c.active && <input type="hidden" name="active" value="on" />}
                    <Button type="submit" variant="ghost" size="sm">{c.active ? t("offers.switchOff") : t("offers.switchOn")}</Button>
                  </form>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="of-first" className="mt-8">
        <h2 id="of-first" className="font-semibold text-text">{t("offers.firstTitle")}</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">{t("offers.firstIntro")}</p>
        <Card className="mt-3 max-w-xl">
          <FirstSessionForm current={first && { kind: first.kind, value: first.kind === "percent" ? String(first.value) : rupees(first.value), active: first.active }} />
        </Card>
      </section>

      <section aria-labelledby="of-camp" className="mt-8">
        <h2 id="of-camp" className="font-semibold text-text">{t("offers.campaignsTitle")}</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">{t("offers.campaignsIntro", { timezone: user.timezone })}</p>
        <Card className="mt-3 max-w-xl"><CampaignForm eventTypes={paid} packages={pkgs} today={today} /></Card>
        {campaigns.length > 0 && (
          <ul className="mt-4 grid max-w-xl gap-3">
            {campaigns.map((c) => {
              const state = t(!c.active ? "offers.stateOff" : campaignLive(c, now, user.timezone) ? "offers.stateLive" : c.endsOn < today ? "offers.stateEnded" : "offers.stateScheduled");
              return (
                <li key={c.id}>
                  <Card className="grid gap-2">
                    <p className="font-semibold text-text">{c.name} <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">{state}</span></p>
                    <p className="text-sm text-text">{c.banner}</p>
                    <p className="text-sm text-text-muted">{t("offers.campaignTerms", { discount: off(c.discount), start: c.startsOn, end: c.endsOn, items: forWhat(c) })}</p>
                    <form action={toggleOffer}>
                      <input type="hidden" name="what" value="campaign" /><input type="hidden" name="id" value={c.id} />
                      {!c.active && <input type="hidden" name="active" value="on" />}
                      <Button type="submit" variant="ghost" size="sm">{c.active ? t("offers.switchOff") : t("offers.switchOn")}</Button>
                    </form>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="of-slide" className="mt-8">
        <h2 id="of-slide" className="font-semibold text-text">{t("offers.slidingTitle")}</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">{t("offers.slidingIntro")}</p>
        <ul className="mt-3 grid max-w-xl gap-3">
          {paid.map((e) => {
            const s = sliding.get(e.id);
            return (
              <li key={e.id}>
                <Card className="grid gap-3">
                  <p className="font-semibold text-text">{e.name} <span className="font-normal text-text-muted">{t("offers.listedAt", { price: inr(e.priceMinor) })}</span></p>
                  <SlidingForm eventTypeId={e.id} current={s ? { min: rupees(s.minMinor), suggested: rupees(s.suggestedMinor), max: rupees(s.maxMinor), note: s.note ?? "" } : null} />
                  {s && (
                    <form action={removeSlidingAction}>
                      <input type="hidden" name="eventTypeId" value={e.id} />
                      <Button type="submit" variant="ghost" size="sm">{t("offers.backToFixed")}</Button>
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
