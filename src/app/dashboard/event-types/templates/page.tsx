import Link from "next/link";
import { startFromExample } from "./actions";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { STARTER_NAME_KEYS, STARTER_SUMMARY_KEYS, templatesEnabled } from "@/lib/intake/options";
import { getHostI18n } from "@/lib/i18n/host/server";
import { STARTERS } from "@/lib/intake/starters";
import { listTemplates } from "@/lib/intake/templates";

export const dynamic = "force-dynamic";

export default async function IntakeTemplatesPage() {
  const user = await requireHost();
  const { t } = await getHostI18n();
  const enabled = templatesEnabled();
  const templates = enabled ? await listTemplates(getPool(process.env.DATABASE_URL as string), user.id) : [];

  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("eventTypes.backToList")}</Link>
      <h1 className="mt-2 font-display text-xl text-text">{t("intake.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("intake.intro")}</p>
      {!enabled && <p className="mt-4 max-w-xl rounded-md bg-surface p-3 text-sm text-text">{t("intake.noDatabase")}</p>}

      {enabled && (
        <section aria-labelledby="tpl-mine" className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="tpl-mine" className="font-semibold text-text">{t("intake.mine")}</h2>
            <Link href="/dashboard/event-types/templates/new" className={buttonClasses({ variant: "secondary" })}>{t("intake.new")}</Link>
          </div>
          {templates.length === 0 ? <p className="mt-2 text-text-muted">{t("intake.none")}</p> : (
            <ul className="mt-3 grid gap-3">
              {templates.map((tpl) => (
                <li key={tpl.id}>
                  <Card className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-text">{tpl.name}{tpl.example && <span className="ml-2 rounded-sm bg-warning-bg px-2 py-0.5 text-xs font-normal">{t("intake.exampleBadge")}</span>}</p>
                      <p className="text-sm text-text-muted">{tpl.questions.length === 1 ? t("intake.oneQuestion") : t("intake.questions", { n: tpl.questions.length })}</p>
                    </div>
                    <Link href={`/dashboard/event-types/templates/${tpl.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("intake.editOrApply")}</Link>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="tpl-examples" className="mt-8">
        <h2 id="tpl-examples" className="font-semibold text-text">{t("intake.examplesTitle")}</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">{t("intake.examplesIntro")}</p>
        <ul className="mt-3 grid gap-3">
          {STARTERS.map((s) => (
            <li key={s.key}>
              <Card className="grid gap-2">
                <p className="font-semibold text-text">{t(STARTER_NAME_KEYS[s.key])} <span className="ml-1 rounded-sm bg-warning-bg px-2 py-0.5 text-xs font-normal">{t("intake.example")}</span></p>
                <p className="text-sm text-text-muted">{t(STARTER_SUMMARY_KEYS[s.key])}</p>
                <ul className="list-disc pl-5 text-sm text-text">{s.questions.map((q) => <li key={q.label}>{q.label}</li>)}</ul>
                {enabled && (
                  <form action={startFromExample}>
                    <input type="hidden" name="starter" value={s.key} />
                    <Button type="submit" variant="secondary">{t("intake.useAsTemplate")}</Button>
                  </form>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
