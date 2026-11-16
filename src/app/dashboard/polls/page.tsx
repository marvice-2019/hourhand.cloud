import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime } from "@/lib/format";
import { acceptsVotes, listPolls, type PollStatus } from "@/lib/polls/polls";

export const dynamic = "force-dynamic";

const STATE: Record<PollStatus | "awaiting", { label: string; className: string }> = {
  open: { label: "Voting", className: "bg-success-bg text-success" },
  awaiting: { label: "Pick a time", className: "bg-surface text-text" },
  closed: { label: "Pick a time", className: "bg-surface text-text" },
  confirmed: { label: "Booked", className: "bg-surface text-text" },
  cancelled: { label: "Cancelled", className: "bg-surface text-text-muted" },
};

export default async function PollsPage() {
  const user = await requireHost();
  const now = new Date();
  const polls = authEnabled() ? await listPolls(getPool(process.env.DATABASE_URL as string), user.id) : [];
  const tz = user.timezone;
  return (
    <div>
      <h1 className="font-display text-xl text-text">Polls</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        Propose a few times for one meeting, like a batch start or a parent-teacher call. Share one link; people mark the times they can make
        without signing up. You confirm the best time with one click and everyone who can make it is booked.
      </p>
      {authEnabled() ? (
        <Link href="/dashboard/polls/new" className={`mt-4 ${buttonClasses()}`}>New poll</Link>
      ) : (
        <p className="mt-4 text-text-muted">Meeting polls need the database, which this demo copy doesn&apos;t have.</p>
      )}

      <h2 className="mt-10 font-semibold text-text">Your polls</h2>
      {polls.length === 0 ? (
        <p className="mt-2 text-text-muted">No polls yet.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {polls.map((p) => {
            const state = p.status === "open" && !acceptsVotes(p, now) ? STATE.awaiting : STATE[p.status];
            return (
              <li key={p.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-text">
                      {p.title}
                      <span className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${state.className}`}>{state.label}</span>
                    </p>
                    <p className="text-sm text-text-muted">
                      {p.times} times · {p.voters} {p.voters === 1 ? "answer" : "answers"}
                      {p.status === "open" && acceptsVotes(p, now) && <> · closes {formatDate(p.deadline, tz)}, {formatTime(p.deadline, tz, user.timeFormat)}</>}
                      {p.confirmedStart && <> · {formatDate(p.confirmedStart, tz)}, {formatTime(p.confirmedStart, tz, user.timeFormat)}</>}
                    </p>
                  </div>
                  <Link href={`/dashboard/polls/${p.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
                    {p.status === "open" || p.status === "closed" ? "See answers" : "Details"}
                  </Link>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
