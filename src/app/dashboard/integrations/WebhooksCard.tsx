import type pg from "pg";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label } from "@/components/ui/Input";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { endpointKey, listEndpoints, MAX_ENDPOINTS, WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhooks/webhooks";
import { addWebhook, deleteWebhook, pingWebhook } from "./webhook-actions";

const EVENT_LABEL: Record<WebhookEvent, HostKey> = {
  "booking.created": "integrations.whEventCreated",
  "booking.cancelled": "integrations.whEventCancelled",
  "booking.rescheduled": "integrations.whEventRescheduled",
};
const NOTICE: Record<string, { key: HostKey; ok: boolean }> = {
  added: { key: "integrations.whAdded", ok: true },
  deleted: { key: "integrations.whDeleted", ok: true },
  ping: { key: "integrations.whPingQueued", ok: true },
  not_https: { key: "integrations.whNotHttps", ok: false },
  bad_url: { key: "integrations.whBadUrl", ok: false },
  private_address: { key: "integrations.whPrivate", ok: false },
  no_events: { key: "integrations.whNoEvents", ok: false },
  too_many: { key: "integrations.whTooMany", ok: false },
};

/** Booking webhooks: the host sends new, cancelled and moved bookings to their own n8n, Zapier, Make or CRM. */
export async function WebhooksCard({ pool, hostId, notice }: { pool: pg.Pool | null; hostId: string; notice?: string }) {
  const { t } = await getHostI18n();
  const ready = pool !== null && Boolean(process.env.TOKEN_ENCRYPTION_KEY);
  const endpoints = ready ? await listEndpoints(pool, hostId) : [];
  const keys = ready ? await Promise.all(endpoints.map((e) => endpointKey(pool, hostId, e.id))) : [];
  const n = notice && Object.hasOwn(NOTICE, notice) ? NOTICE[notice] : null;

  return (
    <Card className="mt-6 max-w-2xl" id="webhooks">
      <h2 className="font-semibold text-text">{t("integrations.whTitle")}</h2>
      <p className="mt-1 text-text-muted">{t("integrations.whBody")}</p>
      {n && <p role={n.ok ? "status" : "alert"} className={`mt-3 ${n.ok ? "text-success" : "text-danger"}`}>{t(n.key, { n: MAX_ENDPOINTS })}</p>}
      {!ready ? (
        <p className="mt-4 text-sm text-text-muted">{t("integrations.whNotSetUp")}</p>
      ) : (
        <>
          {endpoints.length > 0 && (
            <ul className="mt-4 grid gap-4">
              {endpoints.map((e, i) => (
                <li key={e.id} className="rounded-md border border-border p-3">
                  <p className="break-all font-semibold text-text">{e.url}</p>
                  <p className="mt-1 text-sm text-text-muted">{e.events.map((ev) => t(EVENT_LABEL[ev])).join(", ")}</p>
                  <p className="mt-1 text-sm text-text-muted">
                    {e.lastDeliveryAt === null ? t("integrations.whNeverSent")
                      : e.lastError === null ? t("integrations.whLastOk", { status: String(e.lastStatus ?? "") })
                      : t("integrations.whLastFailed", { error: e.lastError })}
                  </p>
                  <details className="mt-2 text-sm">
                    <summary className="min-h-11 cursor-pointer font-semibold text-accent">{t("integrations.whShowKey")}</summary>
                    <code className="mt-1 block break-all rounded bg-surface px-2 py-1 text-text">{keys[i]}</code>
                    <p className="mt-1 text-text-muted">{t("integrations.whKeyHint")}</p>
                  </details>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <form action={pingWebhook}><input type="hidden" name="id" value={e.id} /><Button type="submit" variant="secondary">{t("integrations.whTest")}</Button></form>
                    <form action={deleteWebhook}><input type="hidden" name="id" value={e.id} /><Button type="submit" variant="secondary">{t("integrations.whRemove")}</Button></form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {endpoints.length < MAX_ENDPOINTS && (
            <form action={addWebhook} className="mt-4 grid gap-3">
              <div>
                <Label htmlFor="wh-url">{t("integrations.whUrl")}</Label>
                <Input id="wh-url" name="url" type="url" required inputMode="url" autoComplete="off" />
              </div>
              <fieldset>
                <legend className="text-sm font-semibold text-text">{t("integrations.whEvents")}</legend>
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex min-h-11 items-center gap-3 text-text">
                    <input type="checkbox" name={ev} defaultChecked className="size-5 shrink-0" />
                    {t(EVENT_LABEL[ev])}
                  </label>
                ))}
              </fieldset>
              <div><Button type="submit">{t("integrations.whAdd")}</Button></div>
            </form>
          )}
        </>
      )}
    </Card>
  );
}
