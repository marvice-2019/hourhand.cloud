import Link from "next/link";
import { redirect } from "next/navigation";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { listPracticeBookings, weekRange } from "@/lib/clinic/bookings";
import { practiceContext } from "@/lib/clinic/practices";
import { allowed } from "@/lib/clinic/roles";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime, zoneName } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Every practitioner's bookings, for the practice's owner and admins. Names and times only: notes stay with each practitioner. */
export default async function PracticeBookingsPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/practice");
  const db = getPool(process.env.DATABASE_URL as string);
  const ctx = await practiceContext(db, user.id);
  if (!ctx || !allowed(ctx.role, "bookings.view_all")) redirect("/dashboard/practice?error=forbidden");
  const { from: start, to: end, week } = weekRange(Number.parseInt((await searchParams).week ?? "0", 10) || 0);
  const bookings = await listPracticeBookings(db, user.id, { from: start, to: end });
  const tz = user.timezone;
  const nav = `inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-accent underline ${focusRing}`;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{ctx.practice.name}: bookings</h1>
      <p className="mt-2 text-text-muted">
        {formatDate(start, tz)} to {formatDate(new Date(end.getTime() - 1), tz)}, every practitioner. Times in {zoneName(tz)}.
      </p>
      <div className="mt-2 flex gap-2">
        <Link className={nav} href={`/dashboard/practice/bookings?week=${week - 1}`}>Previous week</Link>
        {week !== 0 && <Link className={nav} href="/dashboard/practice/bookings">This week</Link>}
        <Link className={nav} href={`/dashboard/practice/bookings?week=${week + 1}`}>Next week</Link>
      </div>
      {bookings.length === 0 ? (
        <p className="mt-6 text-text-muted">No bookings this week.</p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {bookings.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-2">
              <span className="text-text">{formatDate(b.startAt, tz)}, {formatTime(b.startAt, tz)}</span>
              <span className="font-semibold text-text">{b.practitioner.name}</span>
              <span className="text-text-muted">{b.eventName}</span>
              <span className={b.status === "cancelled" ? "text-text-muted line-through" : "text-text"}>{b.guests.map((g) => g.name).join(", ")}</span>
              {b.status !== "confirmed" && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{b.status === "cancelled" ? "Cancelled" : "Awaiting payment"}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
