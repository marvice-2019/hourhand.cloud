import { togglePackage } from "./actions";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { PackageForm } from "@/components/PackageForm";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { listPackages, listPurchases } from "@/lib/packages/packages";

export const dynamic = "force-dynamic";

export default async function PackagesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireHost();
  const { t, date, money } = await getHostI18n();
  const { error } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [eventTypes, packages, purchases, account] = await Promise.all([
    store.listEventTypes(user.id), db ? listPackages(db, user.id) : [], db ? listPurchases(db, user.id) : [], db ? paymentAccount(db, user.id) : null,
  ]);
  const names = new Map(eventTypes.map((e) => [e.id, e.name]));
  const bookable = eventTypes.filter((e) => e.active && e.kind === "one_on_one").map(({ id, name }) => ({ id, name }));
  const tz = user.timezone;

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("packages.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("packages.intro")}</p>
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("packages.notFound")}</p>}

      <Card className="mt-6 max-w-xl"><h2 className="mb-4 font-semibold text-text">{t("packages.new")}</h2><PackageForm eventTypes={bookable} currency={priceCurrency(account)} /></Card>

      <section aria-labelledby="pk-list" className="mt-8">
        <h2 id="pk-list" className="font-semibold text-text">{t("packages.yours")}</h2>
        {packages.length === 0 ? <p className="mt-2 text-text-muted">{t("packages.none")}</p> : (
          <ul className="mt-3 grid max-w-xl gap-3">
            {packages.map((p) => (
              <li key={p.id}>
                <Card className="grid gap-2">
                  <p className="font-semibold text-text">{p.name} {!p.active && <span className="ml-2 rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">{t("packages.offSale")}</span>}</p>
                  <p className="text-sm text-text-muted">
                    {t("packages.summary", { sessions: p.sessions, eventType: names.get(p.eventTypeId) ?? t("packages.eventTypeFallback"), price: money(p.priceMinor, p.currency), days: p.validDays })}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <CopyLinkButton path={`/pkg/${p.id}`} />
                    <form action={togglePackage}>
                      <input type="hidden" name="packageId" value={p.id} />
                      {!p.active && <input type="hidden" name="active" value="on" />}
                      <Button type="submit" variant="ghost" size="sm">{p.active ? t("packages.takeOff") : t("packages.putOn")}</Button>
                    </form>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pk-sold" className="mt-8">
        <h2 id="pk-sold" className="font-semibold text-text">{t("packages.sold")}</h2>
        {purchases.length === 0 ? <p className="mt-2 text-text-muted">{t("packages.noSales")}</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full max-w-3xl text-left text-sm">
              <thead><tr className="text-text-muted"><th className="py-2 pr-4 font-medium">{t("packages.buyer")}</th><th className="py-2 pr-4 font-medium">{t("packages.used")}</th><th className="py-2 pr-4 font-medium">{t("packages.paid")}</th><th className="py-2 font-medium">{t("packages.bookBy")}</th></tr></thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id} className="border-t border-border text-text">
                    <td className="py-2 pr-4">{p.guestName}<br /><span className="text-text-muted">{p.guestEmail}</span></td>
                    <td className="py-2 pr-4">{t("packages.usedOf", { used: p.used, sessions: p.sessions })}</td>
                    <td className="py-2 pr-4">{money(p.priceMinor, p.currency)}<br /><span className="text-text-muted">{date(p.paidAt!, tz)}</span></td>
                    <td className="py-2">{date(p.expiresAt!, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
