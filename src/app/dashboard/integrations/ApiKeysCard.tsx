import type pg from "pg";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { listApiKeys, MAX_API_KEYS } from "@/lib/api/keys";
import { resolveBaseUrl } from "@/lib/auth/auth";
import { getHostI18n } from "@/lib/i18n/host/server";
import { removeApiKey } from "./api-key-actions";

/** B14: personal API keys, so the host's n8n, Zapier, CRM or sheet can read their bookings and event types. */
export async function ApiKeysCard({ pool, hostId, timezone, notice }: { pool: pg.Pool | null; hostId: string; timezone: string; notice?: string }) {
  const { t, shortDate } = await getHostI18n();
  const keys = pool ? await listApiKeys(pool, hostId) : [];
  const endpoint = new URL("/api/v1/bookings", resolveBaseUrl() ?? "https://hourhand.cloud").toString();
  return (
    <Card className="mt-6 max-w-2xl" id="api-keys">
      <h2 className="font-semibold text-text">{t("integrations.apiTitle")}</h2>
      <p className="mt-1 text-text-muted">{t("integrations.apiBody")}</p>
      <p className="mt-2 text-sm text-text-muted">{t("integrations.apiHow")}</p>
      <code className="mt-1 block break-all rounded bg-surface px-2 py-1 text-sm text-text">{endpoint}</code>
      {notice === "deleted" && <p role="status" className="mt-3 text-success">{t("integrations.apiDeleted")}</p>}
      {!pool ? (
        <p className="mt-4 text-sm text-text-muted">{t("integrations.apiNotSetUp")}</p>
      ) : (
        <>
          {keys.length > 0 && (
            <ul className="mt-4 grid gap-4">
              {keys.map((k) => (
                <li key={k.id} className="rounded-md border border-border p-3">
                  <p className="font-semibold text-text">{k.name}</p>
                  <p className="mt-1 text-sm text-text-muted">
                    <code>{t("integrations.apiPrefix", { prefix: k.prefix })}</code>
                    {" · "}{t("integrations.apiCreated", { date: shortDate(k.createdAt, timezone) })}
                    {" · "}{k.lastUsedAt ? t("integrations.apiLastUsed", { date: shortDate(k.lastUsedAt, timezone) }) : t("integrations.apiNeverUsed")}
                  </p>
                  <form action={removeApiKey} className="mt-3">
                    <input type="hidden" name="id" value={k.id} />
                    <Button type="submit" variant="secondary">{t("integrations.apiRemove")}</Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <ApiKeyForm max={MAX_API_KEYS} canAdd={keys.length < MAX_API_KEYS} keyIds={keys.map((k) => k.id)} />
        </>
      )}
    </Card>
  );
}
