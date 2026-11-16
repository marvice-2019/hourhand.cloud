import Link from "next/link";
import { ICloudConnectForm } from "@/components/ICloudConnectForm";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { calendarDeps } from "@/lib/calendar/env";
import { PROVIDER_NAMES } from "@/lib/calendar/provider";
import { store, type CalendarConnection } from "@/lib/data";
import type { HostKey } from "@/lib/i18n/host";
import type { HostI18n } from "@/lib/i18n/host/format";
import { getHostI18n } from "@/lib/i18n/host/server";
import { SYNC_STALE_AFTER_MINUTES } from "@/lib/slots";
import { disconnectCalendar, toggleConflictCheck, useForBookings } from "./actions";

// The connect links never prefetch: a prefetch would start an OAuth handshake nobody asked for.
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, HostKey> = {
  denied: "calendars.errorDenied",
  missing_permissions: "calendars.errorMissingPermissions",
  state_mismatch: "calendars.errorStateMismatch",
  expired: "calendars.errorExpired",
  wrong_user: "calendars.errorWrongUser",
  google: "calendars.errorGoogle",
  microsoft_denied: "calendars.errorMicrosoftDenied",
  microsoft_missing_permissions: "calendars.errorMicrosoftMissingPermissions",
  microsoft: "calendars.errorMicrosoft",
  microsoft_not_configured: "calendars.errorMicrosoftNotConfigured",
  not_configured: "calendars.errorNotConfigured",
  demo: "calendars.errorDemo",
  calendar_limit: "calendars.errorCalendarLimit",
};

function health(c: CalendarConnection, now: Date, t: HostI18n["t"]): { tone: string; words: string } {
  if (c.status === "disconnected") return { tone: "bg-danger-bg text-danger", words: t("calendars.healthDisconnected") };
  if (!c.lastSyncedAt) return { tone: "bg-warning-bg text-warning", words: t("calendars.healthFirstSync") };
  const minutes = Math.floor((now.getTime() - c.lastSyncedAt.getTime()) / 60_000);
  if (c.status === "degraded" || minutes > SYNC_STALE_AFTER_MINUTES) {
    return { tone: "bg-warning-bg text-warning", words: minutes > SYNC_STALE_AFTER_MINUTES ? t("calendars.healthStale") : t("calendars.healthSlow") };
  }
  return { tone: "bg-success-bg text-success", words: t("calendars.healthOk", { n: minutes }) };
}

function calendarState(checkConflicts: boolean, isAddTo: boolean): HostKey {
  if (checkConflicts) return isAddTo ? "calendars.checkedAddTo" : "calendars.checked";
  return isAddTo ? "calendars.notCheckedAddTo" : "calendars.notChecked";
}

export default async function CalendarsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const [connections, calendars] = await Promise.all([store.listCalendarConnections(user.id), store.listCalendars(user.id)]);
  const live = authEnabled();
  const providers = live ? (calendarDeps()?.providers ?? {}) : {};
  const canGoogle = Boolean(providers.google);
  const canOutlook = Boolean(providers.microsoft);
  const canICloud = Boolean(providers.icloud);
  const canConnect = canGoogle || canOutlook || canICloud;
  const now = new Date();
  const { t } = await getHostI18n();

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("calendars.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {t("calendars.intro")}
      </p>

      {params.connected && <p role="status" className="mt-4 text-success">{t("calendars.connected")}</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(MESSAGES, params.error) && MESSAGES[params.error]) || MESSAGES.google)}</p>}

      <div className="mt-6 grid max-w-2xl gap-4">
        {connections.length === 0 && (
          <Card>
            <h2 className="font-semibold text-text">{t("calendars.noneTitle")}</h2>
            <p className="mt-1 text-text-muted">{t("calendars.noneBody")}</p>
          </Card>
        )}
        {connections.map((c) => {
          const h = health(c, now, t);
          const own = calendars.filter((cal) => cal.connectionId === c.id);
          return (
            <Card key={c.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-text">{PROVIDER_NAMES[c.provider as keyof typeof PROVIDER_NAMES] ?? c.provider} · {c.accountEmail}</h2>
                  <span className={`mt-1 inline-flex items-center gap-2 rounded-pill px-3 py-1 text-xs ${h.tone}`}>
                    <span aria-hidden className="size-2 rounded-pill bg-current" />
                    {h.words}
                  </span>
                  {c.lastError && c.status !== "ok" && <p className="mt-1 text-sm text-text-muted">{t("calendars.lastError", { error: c.lastError.slice(0, 160) })}</p>}
                </div>
                {live && (
                  <form action={disconnectCalendar}>
                    <input type="hidden" name="connectionId" value={c.id} />
                    <Button type="submit" variant="secondary" size="sm">{t("calendars.disconnect")}</Button>
                  </form>
                )}
              </div>
              {c.status === "disconnected" && c.provider === "google" && canGoogle && (
                <Link prefetch={false} href="/api/calendars/google/connect" className={`${buttonClasses()} mt-4`}>{t("calendars.reconnectGoogle")}</Link>
              )}
              {c.status === "disconnected" && c.provider === "microsoft" && canOutlook && (
                <Link prefetch={false} href="/api/calendars/microsoft/connect" className={`${buttonClasses()} mt-4`}>{t("calendars.reconnectOutlook")}</Link>
              )}
              <ul className="mt-4 divide-y divide-border">
                {own.map((cal) => (
                  <li key={cal.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-text">{cal.name}</p>
                      <p className="text-sm text-text-muted">{t(calendarState(cal.checkConflicts, cal.isAddTo))}</p>
                    </div>
                    {live && (
                      <div className="flex flex-wrap gap-2">
                        <form action={toggleConflictCheck}>
                          <input type="hidden" name="calendarId" value={cal.id} />
                          <input type="hidden" name="on" value={cal.checkConflicts ? "0" : "1"} />
                          <Button type="submit" variant="ghost" size="sm" aria-label={t(cal.checkConflicts ? "calendars.stopCheckingAria" : "calendars.checkAria", { name: cal.name })}>
                            {cal.checkConflicts ? t("calendars.stopChecking") : t("calendars.check")}
                          </Button>
                        </form>
                        {cal.canWrite && !cal.isAddTo && (
                          <form action={useForBookings}>
                            <input type="hidden" name="calendarId" value={cal.id} />
                            <Button type="submit" variant="ghost" size="sm" aria-label={t("calendars.addHereAria", { name: cal.name })}>{t("calendars.addHere")}</Button>
                          </form>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      {canConnect ? (
        <div className="mt-6 flex flex-wrap gap-3">
          {canGoogle && (
            <Link prefetch={false} href="/api/calendars/google/connect" className={buttonClasses()}>
              {connections.length ? t("calendars.connectAnotherGoogle") : t("calendars.connectGoogle")}
            </Link>
          )}
          {canOutlook && (
            <Link prefetch={false} href="/api/calendars/microsoft/connect" className={buttonClasses()}>
              {connections.length ? t("calendars.connectAnotherOutlook") : t("calendars.connectOutlook")}
            </Link>
          )}
          {canICloud && (
            <details className="w-full rounded-md border border-border p-4">
              <summary className="min-h-11 cursor-pointer content-center font-semibold text-text">{connections.length ? t("calendars.connectAnotherICloud") : t("calendars.connectICloud")}</summary>
              <div className="mt-3"><ICloudConnectForm /></div>
            </details>
          )}
        </div>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">{live ? t(MESSAGES.not_configured) : t(MESSAGES.demo)}</p>
      )}
    </div>
  );
}
