import Link from "next/link";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext, requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { listRequests } from "@/lib/privacy/rights";
import { summarizeClients } from "@/lib/clients";
import { store } from "@/lib/data";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ error?: string; erased?: string }> }) {
  const user = await requireHost();
  const { error, erased } = await searchParams;
  // Data requests are the owner's to answer; a Duo second person doesn't see them.
  const owner = !(await getHostContext())?.acting;
  const openRequests = owner && authEnabled() ? (await listRequests(getPool(process.env.DATABASE_URL as string), user.id)).filter((r) => r.status === "open").length : 0;
  const clients = summarizeClients(await store.listBookings(user.id), new Date());
  const tz = user.timezone;
  return (
    <div>
      <h1 className="font-display text-xl text-text">Clients</h1>
      <p className="mt-2 max-w-xl text-text-muted">Everyone who has booked you, with their sessions and your private notes. Clients with a session coming up are first.</p>
      {owner && (
        <p className="mt-2 text-sm">
          <Link href="/dashboard/clients/requests" className="inline-flex min-h-11 items-center font-semibold text-accent underline">
            Data requests{openRequests > 0 ? ` (${openRequests} open)` : ""}
          </Link>
        </p>
      )}
      {erased && <p role="status" className="mt-4 text-success">Client erased. Their past bookings show as &ldquo;Erased client&rdquo;.</p>}
      {error === "not_found" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">That client isn&apos;t in your bookings.</p>}
      {clients.length === 0 ? <p className="mt-6 text-text-muted">No clients yet. They appear here after their first booking.</p> : (
        <ul className="mt-4 grid gap-2">
          {clients.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-2">
              <Link href={`/dashboard/clients/${c.key}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{c.name}</Link>
              <span className="text-sm text-text-muted">{c.sessions} {c.sessions === 1 ? "session" : "sessions"}</span>
              {c.nextAt && <span className="text-sm text-text">Next: {formatDate(c.nextAt, tz)}</span>}
              {!c.nextAt && c.lastAt && <span className="text-sm text-text-muted">Last: {formatDate(c.lastAt, tz)}</span>}
              {c.noShows > 0 && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{c.noShows} no-show{c.noShows > 1 ? "s" : ""}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
