import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { clientKey } from "@/lib/clients";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";
import { isErasedEmail, listErasures, listRequests, RESPONSE_DAYS } from "@/lib/privacy/rights";
import { resolveRequestAction } from "../privacy-actions";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const KIND: Record<string, string> = { access: "Copy of their data", erasure: "Delete their data" };

/** The owner's clients' data requests (from their booking links) with deadlines, and the log of erasures. Owner only. */
export default async function DataRequestsPage({ searchParams }: { searchParams: Promise<{ resolved?: string; error?: string }> }) {
  const user = await requireOwnAccount();
  const { resolved, error } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [requests, erasures] = db ? await Promise.all([listRequests(db, user.id), listErasures(db, user.id)]) : [[], []];
  const now = new Date().getTime();
  const tz = user.timezone;
  const open = requests.filter((r) => r.status === "open");
  const closed = requests.filter((r) => r.status !== "open");
  return (
    <div>
      <Link href="/dashboard/clients" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">All clients</Link>
      <h1 className="font-display text-xl text-text">Data requests</h1>
      <p className="mt-2 max-w-2xl text-text-muted">
        Clients can ask, from their booking link, for a copy of what you hold about them or for it to be deleted. You are responsible for answering
        (you&apos;re the data fiduciary; Hourhand is your processor). India&apos;s DPDP Rules allow at most {RESPONSE_DAYS} days; aim for far sooner.
      </p>
      {resolved && <p role="status" className="mt-4 text-success">Request marked {resolved === "declined" ? "declined" : "done"}.</p>}
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">That request isn&apos;t open any more.</p>}

      <section aria-labelledby="open" className="mt-6">
        <h2 id="open" className="font-semibold text-text">Open</h2>
        {open.length === 0 ? <p className="mt-2 text-text-muted">No open requests.</p> : (
          <ul className="mt-2 grid gap-2">
            {open.map((r) => {
              const daysLeft = Math.ceil((r.dueAt.getTime() - now) / DAY);
              return (
                <li key={r.id} className="grid gap-2 rounded-md border border-border bg-card px-4 py-3">
                  <p className="text-text">
                    <span className="font-semibold">{KIND[r.kind]}</span> · asked {formatDate(r.requestedAt, tz)} ·{" "}
                    <Link href={`/dashboard/clients/${clientKey(r.email)}#data`} className="text-accent underline">{r.email}</Link>
                  </p>
                  <p className={daysLeft <= 7 ? "font-semibold text-danger" : "text-text"}>
                    Respond by {formatDate(r.dueAt, tz)} ({daysLeft < 0 ? `${-daysLeft} days overdue` : `${daysLeft} days left`})
                  </p>
                  <p className="text-sm text-text-muted">
                    {r.kind === "access"
                      ? "Download their export from the client's page, send it to them, then mark this done."
                      : "Erase them from the client's page (this closes the request), or decline if the law requires you to keep something and tell them why."}
                  </p>
                  <form action={resolveRequestAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    {r.kind === "access" && <Button type="submit" name="status" value="done" variant="secondary" size="sm">Mark done</Button>}
                    <Button type="submit" name="status" value="declined" variant="ghost" size="sm">Decline</Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section aria-labelledby="closed" className="mt-8">
          <h2 id="closed" className="font-semibold text-text">Dealt with</h2>
          <ul className="mt-2 grid gap-1 text-sm text-text-muted">
            {closed.map((r) => (
              <li key={r.id}>{KIND[r.kind]} · asked {formatDate(r.requestedAt, tz)} · {r.status}{r.resolvedAt && ` ${formatDate(r.resolvedAt, tz)}`}{isErasedEmail(r.email) ? " · client erased" : ` · ${r.email}`}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="erasures" className="mt-8">
        <h2 id="erasures" className="font-semibold text-text">Erasure log</h2>
        <p className="mt-1 text-sm text-text-muted">Who erased a client and when. It never records who was erased.</p>
        {erasures.length === 0 ? <p className="mt-2 text-sm text-text-muted">No clients erased.</p> : (
          <ul className="mt-2 grid gap-1 text-sm text-text">
            {erasures.map((e) => <li key={e.id}>{formatDate(e.erasedAt, tz)} by {e.actorName ?? "a former member"}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
