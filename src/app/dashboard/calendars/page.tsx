import Link from "next/link";
import { ICloudConnectForm } from "@/components/ICloudConnectForm";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label } from "@/components/ui/Input";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { calendarDeps } from "@/lib/calendar/env";
import { PROVIDER_NAMES } from "@/lib/calendar/provider";
import { store, type CalendarConnection } from "@/lib/data";
import { SYNC_STALE_AFTER_MINUTES } from "@/lib/slots";
import { getPool } from "@/lib/data/pg-store";
import { HOST_ALERT_ERRORS, type HostAlertError } from "@/lib/host-alerts";
import { whatsappConfig } from "@/lib/whatsapp-cloud";
import { disconnectCalendar, saveWhatsAppAlerts, toggleConflictCheck, useForBookings } from "./actions";

// The connect links never prefetch: a prefetch would start an OAuth handshake nobody asked for.
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  denied: "Google didn't connect: the request was cancelled. Try again when you're ready.",
  missing_permissions: "Hourhand needs every permission on Google's screen to check your availability and add bookings. Connect again and leave them all ticked.",
  state_mismatch: "That connection link didn't match this browser. Start again from this page.",
  expired: "That took longer than 10 minutes. Start again from this page.",
  wrong_user: "You signed in as someone else partway through. Start again from this page.",
  google: "Google didn't respond as expected. Try again in a minute.",
  microsoft_denied: "Microsoft didn't connect: the request was cancelled. Try again when you're ready.",
  microsoft_missing_permissions: "Hourhand needs every permission on Microsoft's screen to check your availability and add bookings. Connect again and accept them all.",
  microsoft: "Microsoft didn't respond as expected. Try again in a minute.",
  microsoft_not_configured: "Outlook isn't set up on this server yet.",
  not_configured: "Google Calendar isn't set up on this server yet.",
  demo: "The demo data can't connect a real calendar. Sign in with the database set up to connect one.",
  calendar_limit: "The Free plan checks 2 calendars for conflicts. Stop checking one first, or move to Solo for unlimited calendars.",
};

function health(c: CalendarConnection, now: Date): { tone: string; words: string } {
  if (c.status === "disconnected") return { tone: "bg-danger-bg text-danger", words: "Disconnected. Bookings paused until you reconnect" };
  if (!c.lastSyncedAt) return { tone: "bg-warning-bg text-warning", words: "First sync in progress" };
  const minutes = Math.floor((now.getTime() - c.lastSyncedAt.getTime()) / 60_000);
  if (c.status === "degraded" || minutes > SYNC_STALE_AFTER_MINUTES) {
    return { tone: "bg-warning-bg text-warning", words: minutes > SYNC_STALE_AFTER_MINUTES ? "Not syncing. Bookings paused, retrying" : "Sync slow, retrying" };
  }
  return { tone: "bg-success-bg text-success", words: `In sync · checked ${minutes} min ago` };
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
  // WhatsApp sync alerts: only offered once WhatsApp is set up on this server.
  const alertsOffered = live && Boolean(whatsappConfig());
  const alertSettings = alertsOffered
    ? (await getPool(process.env.DATABASE_URL as string).query("select whatsapp_number, whatsapp_alerts from users where id = $1", [user.id])).rows[0]
    : null;
  const alertsError = params.alerts_error && Object.hasOwn(HOST_ALERT_ERRORS, params.alerts_error) ? HOST_ALERT_ERRORS[params.alerts_error as HostAlertError] : null;

  return (
    <div>
      <h1 className="font-display text-xl text-text">Calendars</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Hourhand checks these calendars so nobody books you when you&apos;re busy, and adds each booking to the one you choose.
      </p>

      {params.connected && <p role="status" className="mt-4 text-success">Calendar connected. Your busy times are syncing now.</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{(Object.hasOwn(MESSAGES, params.error) && MESSAGES[params.error]) || MESSAGES.google}</p>}

      <div className="mt-6 grid max-w-2xl gap-4">
        {connections.length === 0 && (
          <Card>
            <h2 className="font-semibold text-text">No calendar connected</h2>
            <p className="mt-1 text-text-muted">Without one, Hourhand only knows your working hours and the bookings it made itself.</p>
          </Card>
        )}
        {connections.map((c) => {
          const h = health(c, now);
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
                  {c.lastError && c.status !== "ok" && <p className="mt-1 text-sm text-text-muted">Last error: {c.lastError.slice(0, 160)}</p>}
                </div>
                {live && (
                  <form action={disconnectCalendar}>
                    <input type="hidden" name="connectionId" value={c.id} />
                    <Button type="submit" variant="secondary" size="sm">Disconnect</Button>
                  </form>
                )}
              </div>
              {c.status === "disconnected" && c.provider === "google" && canGoogle && (
                <Link prefetch={false} href="/api/calendars/google/connect" className={`${buttonClasses()} mt-4`}>Reconnect Google Calendar</Link>
              )}
              {c.status === "disconnected" && c.provider === "microsoft" && canOutlook && (
                <Link prefetch={false} href="/api/calendars/microsoft/connect" className={`${buttonClasses()} mt-4`}>Reconnect Outlook</Link>
              )}
              <ul className="mt-4 divide-y divide-border">
                {own.map((cal) => (
                  <li key={cal.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-text">{cal.name}</p>
                      <p className="text-sm text-text-muted">
                        {cal.checkConflicts ? "Checked for conflicts" : "Not checked"}
                        {cal.isAddTo ? " · New bookings go here" : ""}
                      </p>
                    </div>
                    {live && (
                      <div className="flex flex-wrap gap-2">
                        <form action={toggleConflictCheck}>
                          <input type="hidden" name="calendarId" value={cal.id} />
                          <input type="hidden" name="on" value={cal.checkConflicts ? "0" : "1"} />
                          <Button type="submit" variant="ghost" size="sm" aria-label={`${cal.checkConflicts ? "Stop checking" : "Check"} ${cal.name} for conflicts`}>
                            {cal.checkConflicts ? "Stop checking" : "Check for conflicts"}
                          </Button>
                        </form>
                        {cal.canWrite && !cal.isAddTo && (
                          <form action={useForBookings}>
                            <input type="hidden" name="calendarId" value={cal.id} />
                            <Button type="submit" variant="ghost" size="sm" aria-label={`Add new bookings to ${cal.name}`}>Add bookings here</Button>
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
              {connections.length ? "Connect another Google account" : "Connect Google Calendar"}
            </Link>
          )}
          {canOutlook && (
            <Link prefetch={false} href="/api/calendars/microsoft/connect" className={buttonClasses()}>
              {connections.length ? "Connect another Outlook account" : "Connect Outlook"}
            </Link>
          )}
          {canICloud && (
            <details className="w-full rounded-md border border-border p-4">
              <summary className="min-h-11 cursor-pointer content-center font-semibold text-text">{connections.length ? "Connect an iCloud account" : "Connect iCloud"}</summary>
              <div className="mt-3"><ICloudConnectForm /></div>
            </details>
          )}
        </div>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">{live ? MESSAGES.not_configured : MESSAGES.demo}</p>
      )}

      {alertsOffered && (
        <Card className="mt-6 max-w-2xl">
          <h2 id="alerts" className="font-semibold text-text">Sync alerts on WhatsApp</h2>
          <p className="mt-1 text-sm text-text-muted">We always email you if a calendar stops syncing. Add WhatsApp to hear about it on your phone too.</p>
          {params.alerts === "saved" && <p role="status" className="mt-3 text-success">Saved.</p>}
          <form action={saveWhatsAppAlerts} className="mt-4 grid gap-3">
            <div className="max-w-xs">
              <Label htmlFor="alert-phone">WhatsApp number</Label>
              <Input id="alert-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210"
                defaultValue={alertSettings?.whatsapp_number ? `+${alertSettings.whatsapp_number}` : ""} error={alertsError ?? undefined} />
            </div>
            <label className="flex min-h-11 items-center gap-3 text-sm text-text">
              <input name="alerts" type="checkbox" defaultChecked={Boolean(alertSettings?.whatsapp_alerts)} className="size-5" />
              WhatsApp me if a calendar stops syncing
            </label>
            <div><Button type="submit" size="sm">Save</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}
