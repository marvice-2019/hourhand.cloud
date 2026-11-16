import type { SmsUsage } from "@/lib/sms/outbox";

/** "Booking texts this month: 37 of 100", with a bar, and what happens at the limit. Server component. */
export function SmsUsageMeter({ usage, resets }: { usage: SmsUsage; resets: string }) {
  const { used, limit } = usage;
  if (limit === 0) {
    return <p className="mt-1 text-text-muted">Booking texts (SMS) to your guests come with Solo and Duo. On Free, guests get email.</p>;
  }
  const shown = Math.min(used, limit);
  const full = used >= limit;
  const near = !full && used >= limit * 0.8;
  return (
    <div className="mt-2">
      <p className="text-text">
        <span className="font-semibold">{shown}</span> of {limit} used · resets {resets}
      </p>
      <div
        role="meter" aria-label="Booking texts used this month" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={shown}
        aria-valuetext={`${shown} of ${limit}`} className="mt-2 h-2 w-full max-w-sm overflow-hidden rounded-pill bg-surface"
      >
        <div className={`h-full rounded-pill ${full ? "bg-danger" : near ? "bg-warning" : "bg-accent"}`} style={{ width: `${(shown / limit) * 100}%` }} />
      </div>
      {full && <p role="status" className="mt-2 text-sm text-danger">You&apos;ve used this month&apos;s texts. Guests still get every email; texts start again on {resets}.</p>}
      {near && <p role="status" className="mt-2 text-sm text-text-muted">Nearly at this month&apos;s limit. Past it, guests get email only until {resets}.</p>}
    </div>
  );
}
