import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { clientKey } from "@/lib/clients";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { isErasedEmail, listErasures, listRequests, RESPONSE_DAYS, type DataRequest, type RequestKind } from "@/lib/privacy/rights";
import { resolveRequestAction } from "../privacy-actions";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const KIND: Record<RequestKind, HostKey> = { access: "clients.requestAccess", erasure: "clients.requestErasure" };
const STATUS: Record<DataRequest["status"], HostKey> = { open: "clients.requestStatusOpen", done: "clients.requestStatusDone", declined: "clients.requestStatusDeclined" };

/** The owner's clients' data requests (from their booking links) with deadlines, and the log of erasures. Owner only. */
export default async function DataRequestsPage({ searchParams }: { searchParams: Promise<{ resolved?: string; error?: string }> }) {
  const user = await requireOwnAccount();
  const { t, tNodes, date } = await getHostI18n();
  const { resolved, error } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [requests, erasures] = db ? await Promise.all([listRequests(db, user.id), listErasures(db, user.id)]) : [[], []];
  const now = new Date().getTime();
  const tz = user.timezone;
  const open = requests.filter((r) => r.status === "open");
  const closed = requests.filter((r) => r.status !== "open");
  const closedLine = (r: DataRequest) => {
    const vars = { kind: t(KIND[r.kind]), date: date(r.requestedAt, tz), status: t(STATUS[r.status]), email: r.email };
    const erased = isErasedEmail(r.email);
    if (r.resolvedAt) return t(erased ? "clients.closedErasedResolved" : "clients.closedEmailResolved", { ...vars, resolved: date(r.resolvedAt, tz) });
    return t(erased ? "clients.closedErased" : "clients.closedEmail", vars);
  };
  return (
    <div>
      <Link href="/dashboard/clients" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("clients.all")}</Link>
      <h1 className="font-display text-xl text-text">{t("clients.dataRequests")}</h1>
      <p className="mt-2 max-w-2xl text-text-muted">{t("clients.requestsIntro", { n: RESPONSE_DAYS })}</p>
      {resolved && <p role="status" className="mt-4 text-success">{t(resolved === "declined" ? "clients.requestMarkedDeclined" : "clients.requestMarkedDone")}</p>}
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("clients.requestNotOpen")}</p>}

      <section aria-labelledby="open" className="mt-6">
        <h2 id="open" className="font-semibold text-text">{t("clients.requestsOpen")}</h2>
        {open.length === 0 ? <p className="mt-2 text-text-muted">{t("clients.noOpenRequests")}</p> : (
          <ul className="mt-2 grid gap-2">
            {open.map((r) => {
              const daysLeft = Math.ceil((r.dueAt.getTime() - now) / DAY);
              return (
                <li key={r.id} className="grid gap-2 rounded-md border border-border bg-card px-4 py-3">
                  <p className="text-text">
                    {tNodes("clients.requestLine", {
                      kind: <span className="font-semibold">{t(KIND[r.kind])}</span>, date: date(r.requestedAt, tz),
                      email: <Link href={`/dashboard/clients/${clientKey(r.email)}#data`} className="text-accent underline">{r.email}</Link>,
                    })}
                  </p>
                  <p className={daysLeft <= 7 ? "font-semibold text-danger" : "text-text"}>
                    {daysLeft < 0 ? t("clients.respondByOverdue", { date: date(r.dueAt, tz), n: -daysLeft }) : t("clients.respondByLeft", { date: date(r.dueAt, tz), n: daysLeft })}
                  </p>
                  <p className="text-sm text-text-muted">
                    {t(r.kind === "access" ? "clients.accessHelp" : "clients.erasureHelp")}
                  </p>
                  <form action={resolveRequestAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    {r.kind === "access" && <Button type="submit" name="status" value="done" variant="secondary" size="sm">{t("clients.markDone")}</Button>}
                    <Button type="submit" name="status" value="declined" variant="ghost" size="sm">{t("clients.decline")}</Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section aria-labelledby="closed" className="mt-8">
          <h2 id="closed" className="font-semibold text-text">{t("clients.dealtWith")}</h2>
          <ul className="mt-2 grid gap-1 text-sm text-text-muted">
            {closed.map((r) => (
              <li key={r.id}>{closedLine(r)}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="erasures" className="mt-8">
        <h2 id="erasures" className="font-semibold text-text">{t("clients.erasureLog")}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("clients.erasureLogIntro")}</p>
        {erasures.length === 0 ? <p className="mt-2 text-sm text-text-muted">{t("clients.noErasures")}</p> : (
          <ul className="mt-2 grid gap-1 text-sm text-text">
            {erasures.map((e) => <li key={e.id}>{t("clients.erasedBy", { date: date(e.erasedAt, tz), name: e.actorName ?? t("clients.formerMember") })}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
