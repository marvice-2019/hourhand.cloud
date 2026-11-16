import Link from "next/link";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext, requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { listRequests } from "@/lib/privacy/rights";
import { summarizeClients } from "@/lib/clients";
import { store } from "@/lib/data";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ error?: string; erased?: string }> }) {
  const user = await requireHost();
  const { t, date } = await getHostI18n();
  const { error, erased } = await searchParams;
  // Data requests are the owner's to answer; a Duo second person doesn't see them.
  const owner = !(await getHostContext())?.acting;
  const openRequests = owner && authEnabled() ? (await listRequests(getPool(process.env.DATABASE_URL as string), user.id)).filter((r) => r.status === "open").length : 0;
  const clients = summarizeClients(await store.listBookings(user.id), new Date());
  const tz = user.timezone;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("clients.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("clients.intro")}</p>
      {owner && (
        <p className="mt-2 text-sm">
          <Link href="/dashboard/clients/requests" className="inline-flex min-h-11 items-center font-semibold text-accent underline">
            {openRequests > 0 ? t("clients.dataRequestsOpen", { n: openRequests }) : t("clients.dataRequests")}
          </Link>
        </p>
      )}
      {erased && <p role="status" className="mt-4 text-success">{t("clients.erased")}</p>}
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("clients.notFound")}</p>}
      {clients.length === 0 ? <p className="mt-6 text-text-muted">{t("clients.empty")}</p> : (
        <ul className="mt-4 grid gap-2">
          {clients.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-2">
              <Link href={`/dashboard/clients/${c.key}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{c.name}</Link>
              <span className="text-sm text-text-muted">{t(c.sessions === 1 ? "clients.oneSession" : "clients.sessionCount", { n: c.sessions })}</span>
              {c.nextAt && <span className="text-sm text-text">{t("clients.next", { date: date(c.nextAt, tz) })}</span>}
              {!c.nextAt && c.lastAt && <span className="text-sm text-text-muted">{t("clients.last", { date: date(c.lastAt, tz) })}</span>}
              {c.noShows > 0 && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{t(c.noShows > 1 ? "clients.noShowCount" : "clients.oneNoShow", { n: c.noShows })}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
