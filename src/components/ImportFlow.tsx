"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { fetchImportPreview, importSelected } from "@/app/dashboard/event-types/import/actions";
import type { ImportProvider, ImportResult, PreviewState } from "@/lib/import";
import { sayImportMessage } from "@/lib/import/messages";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { focusRing } from "./ui/focus";
import { Input, Label } from "./ui/Input";
import { useHostI18n } from "./HostI18nProvider";
import type { HostKey } from "@/lib/i18n/host";

const idle: PreviewState = { status: "idle" };

const NOT_CARRIED: Record<ImportProvider, HostKey[]> = {
  calendly: [
    "eventTypes.importNcAvailability",
    "eventTypes.importNcIntegrations",
    "eventTypes.importNcMinNotice",
    "eventTypes.importNcTeamsCalendly",
    "eventTypes.importNcGroupLimits",
  ],
  calcom: [
    "eventTypes.importNcAvailability",
    "eventTypes.importNcIntegrations",
    "eventTypes.importNcTeamsCalcom",
    "eventTypes.importNcLengths",
  ],
};

const TOKEN_HELP: Record<ImportProvider, { label: HostKey; help: HostKey; href: string; site: string }> = {
  calendly: {
    label: "eventTypes.importCalendlyToken",
    help: "eventTypes.importCalendlyHelp",
    href: "https://calendly.com/integrations/api_webhooks", site: "calendly.com",
  },
  calcom: {
    label: "eventTypes.importCalcomToken",
    help: "eventTypes.importCalcomHelp",
    href: "https://app.cal.com/settings/developer/api-keys", site: "app.cal.com",
  },
};

export function ImportFlow() {
  const { t, tNodes } = useHostI18n();
  const [state, fetchAction, fetching] = useActionState(fetchImportPreview, idle);
  const [provider, setProvider] = useState<ImportProvider>("calendly");
  const shown = state.status === "idle" ? provider : state.status === "error" ? provider : state.provider;

  return (
    <div className="mt-6 grid gap-6">
      <Card>
        <form action={fetchAction} className="grid gap-4">
          {/* Buttons, not radios: React resets a form after its action runs, which would flip a radio back. */}
          <input type="hidden" name="provider" value={provider} />
          <div role="group" aria-labelledby="imp-from">
            <p id="imp-from" className="text-sm font-semibold text-text">{t("eventTypes.importFrom")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["calendly", "calcom"] as const).map((p) => (
                <Button key={p} variant={provider === p ? "primary" : "secondary"} aria-pressed={provider === p} onClick={() => setProvider(p)}>
                  {p === "calendly" ? "Calendly" : "Cal.com"}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-sm text-text-muted">
            {t(TOKEN_HELP[provider].help)}{" "}
            {tNodes("eventTypes.importTokenNote", {
              link: (
                <a href={TOKEN_HELP[provider].href} className="font-semibold text-accent underline" rel="noopener noreferrer" target="_blank">
                  {t("eventTypes.importOpenSite", { site: TOKEN_HELP[provider].site })}
                </a>
              ),
            })}
          </p>
          {provider === "calcom" && (
            <div>
              <Label htmlFor="imp-user">{t("eventTypes.importUsername")}</Label>
              <Input id="imp-user" name="username" autoComplete="off" placeholder={t("eventTypes.importUsernamePlaceholder")} required
                defaultValue={state.status === "error" ? state.username : ""} />
            </div>
          )}
          <div>
            <Label htmlFor="imp-token">{t(TOKEN_HELP[provider].label)}</Label>
            <Input id="imp-token" name="token" type="password" autoComplete="off" spellCheck={false} required
              error={state.status === "error" ? sayImportMessage(t, state.error) : undefined} />
          </div>
          <div><Button type="submit" loading={fetching}>{t("eventTypes.importFetch")}</Button></div>
        </form>
      </Card>

      {state.status === "preview" && <Preview key={state.sealed} state={state} />}

      <Card>
        <h2 className="font-display text-lg text-text">{t("eventTypes.importNotCarried", { provider: shown === "calendly" ? "Calendly" : "Cal.com" })}</h2>
        <ul className="mt-2 list-disc pl-5 text-sm text-text-muted">
          {NOT_CARRIED[shown].map((line) => <li key={line}>{t(line)}</li>)}
        </ul>
      </Card>
    </div>
  );
}

function Preview({ state }: { state: Extract<PreviewState, { status: "preview" }> }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(state.rows.map((r) => r.sourceId)));
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, startImport] = useTransition();
  const { t } = useHostI18n();

  if (result?.ok) {
    const { created, failed } = result.outcome;
    return (
      <Card role="status">
        <h2 className="font-display text-lg text-text">{t(created.length === 1 ? "eventTypes.importedOne" : "eventTypes.importedMany", { n: created.length })}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("eventTypes.importedNote")}</p>
        <ul className="mt-3 grid gap-2">
          {created.map((c) => (
            <li key={c.id} className="text-sm">
              <Link href={`/dashboard/event-types/${c.id}`} className={`rounded-sm font-semibold text-accent underline ${focusRing}`}>{c.name}</Link>
              <span className="ml-2 font-mono text-xs text-text-muted">/{c.slug}</span>
            </li>
          ))}
        </ul>
        {failed.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold text-text">{t("eventTypes.importNotImported")}</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-danger">
              {failed.map((f, i) => <li key={i}>{f.name}: {sayImportMessage(t, f.error)}</li>)}
            </ul>
          </>
        )}
        <Link href="/dashboard/event-types" className={`mt-4 inline-block rounded-sm text-sm font-semibold text-accent underline ${focusRing}`}>{t("eventTypes.importGoToList")}</Link>
      </Card>
    );
  }

  const toggle = (id: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card>
      <h2 className="font-display text-lg text-text">{t("eventTypes.importPick")}</h2>
      {state.rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{t("eventTypes.importNone")}</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {state.rows.map((r) => (
            <li key={r.sourceId} className="rounded-md border border-border p-3">
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-1 size-4" checked={ticked.has(r.sourceId)} onChange={() => toggle(r.sourceId)} />
                <span>
                  <span className="font-semibold text-text">{r.name}</span>
                  <span className="block text-sm text-text-muted">
                    {t("common.minutes", { n: r.durationMinutes })}{r.seatLimit !== null && ` · ${t("eventTypes.importGroupOf", { n: r.seatLimit })}`}
                    {r.questionCount > 0 && ` · ${t(r.questionCount === 1 ? "eventTypes.importOneQuestion" : "eventTypes.importQuestions", { n: r.questionCount })}`}
                    {r.hidden && ` · ${t("eventTypes.importHidden")}`}
                  </span>
                </span>
              </label>
              {r.notes.length > 0 && (
                <ul className="mt-2 list-disc pl-12 text-sm text-text-muted">
                  {r.notes.map((n, i) => <li key={i}>{sayImportMessage(t, n)}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.skipped.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-text">{t("eventTypes.importLeftBehind")}</h3>
          <ul className="mt-1 list-disc pl-5 text-sm text-text-muted">
            {state.skipped.map((s, i) => <li key={i}>{s.name}: {sayImportMessage(t, s.reason)}</li>)}
          </ul>
        </>
      )}
      {result && !result.ok && <p className="mt-3 text-sm text-danger" role="alert">{sayImportMessage(t, result.error)}</p>}
      {state.rows.length > 0 && (
        <div className="mt-4">
          <Button loading={importing} disabled={ticked.size === 0}
            onClick={() => startImport(async () => setResult(await importSelected(state.sealed, [...ticked])))}>
            {t(ticked.size === 1 ? "eventTypes.importOne" : "eventTypes.importMany", { n: ticked.size })}
          </Button>
        </div>
      )}
    </Card>
  );
}
