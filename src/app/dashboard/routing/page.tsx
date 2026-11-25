import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { listRoutingForms } from "@/lib/routing/routing";

export const dynamic = "force-dynamic";

export default async function RoutingFormsPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  const { done } = await searchParams;
  const forms = authEnabled() ? await listRoutingForms(getPool(process.env.DATABASE_URL as string), user.id) : [];
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("routing.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("routing.intro")}</p>
      {done === "deleted" && <p role="status" className="mt-4 max-w-xl rounded-md bg-success-bg p-3 text-sm text-success">{t("routing.doneDeleted")}</p>}
      {authEnabled() ? (
        <Link href="/dashboard/routing/new" className={`mt-4 ${buttonClasses()}`}>{t("routing.newForm")}</Link>
      ) : (
        <p className="mt-4 text-text-muted">{t("routing.noDb")}</p>
      )}

      <h2 className="mt-10 font-semibold text-text">{t("routing.yourForms")}</h2>
      {forms.length === 0 ? (
        <p className="mt-2 text-text-muted">{t("routing.none")}</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {forms.map((f) => (
            <li key={f.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-text">
                    {f.title}
                    <span className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${f.active ? "bg-success-bg text-success" : "bg-surface text-text-muted"}`}>
                      {t(f.active ? "routing.stateOn" : "routing.stateOff")}
                    </span>
                  </p>
                  <p className="text-sm text-text-muted">{t("routing.summary", { n: f.options.length })}</p>
                </div>
                <Link href={`/dashboard/routing/${f.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("routing.edit")}</Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
