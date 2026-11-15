import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelPollAction } from "../actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { ConfirmTimeForm } from "@/components/PollForms";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime } from "@/lib/format";
import { GUEST_LOCATION_LABELS } from "@/lib/location-labels";
import { acceptsVotes, pollForHost, type PollAnswer } from "@/lib/polls/polls";

export const dynamic = "force-dynamic";

const ANSWER: Record<PollAnswer, string> = { yes: "Yes", if_needed: "If needed", no: "No" };

export default async function PollPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const user = await requireHost();
  const { id } = await params;
  const { done, error } = await searchParams;
  const found = authEnabled() ? await pollForHost(getPool(process.env.DATABASE_URL as string), user.id, id) : null;
  if (!found) notFound();
  const { poll, options, voters } = found;
  const now = new Date();
  const tz = user.timezone;
  const when = (d: Date) => `${formatDate(d, tz)}, ${formatTime(d, tz, user.timeFormat)}`;
  const voting = acceptsVotes(poll, now);
  const deciding = poll.status === "open" || poll.status === "closed";
  const path = `/v/${poll.token}`;

  return (
    <div>
      <Link href="/dashboard/polls" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">Polls</Link>
      <h1 className="font-display text-xl text-text">{poll.title}</h1>
      <p className="mt-2 text-text-muted">
        {poll.durationMinutes} min · {GUEST_LOCATION_LABELS[poll.locationKind]}{poll.locationValue && `: ${poll.locationValue}`}
      </p>
      {poll.description && <p className="mt-2 max-w-xl text-text">{poll.description}</p>}

      {done === "created" && <p role="status" className="mt-4 rounded-md bg-success-bg p-3 text-sm text-text">Your poll is ready. Share the link below.</p>}
      {done === "confirmed" && <p role="status" className="mt-4 rounded-md bg-success-bg p-3 text-sm text-text">Booked. Everyone who said yes or if needed is getting their confirmation now.</p>}
      {done === "cancelled" && <p role="status" className="mt-4 rounded-md bg-surface p-3 text-sm text-text">Poll cancelled. Its times are released and nothing was booked.</p>}
      {error === "not_cancellable" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">That poll can&apos;t be cancelled: it is already decided or cancelled.</p>}

      <Card className="mt-6 grid max-w-xl gap-3">
        {voting && (
          <>
            <p className="font-semibold text-text">Voting is open</p>
            <code className="break-all rounded bg-surface px-2 py-1 text-sm text-text">{path}</code>
            <div><CopyLinkButton path={path} /></div>
            <p className="text-sm text-text-muted">
              Closes {when(poll.deadline)}.{" "}
              {poll.holdTimes ? "These times are held: nobody else can book them until you confirm one or voting closes." : "These times aren't held: others can still book them."}
            </p>
          </>
        )}
        {deciding && !voting && <p className="text-text"><span className="font-semibold">Voting has closed.</span> Pick a time below. The times are no longer held, so confirming checks your calendar again first.</p>}
        {poll.status === "confirmed" && poll.confirmedStart && <p className="text-text"><span className="font-semibold">Booked for {when(poll.confirmedStart)}.</span> The other times are released.</p>}
        {poll.status === "cancelled" && <p className="text-text-muted">This poll was cancelled. Nothing was booked.</p>}
      </Card>

      <h2 className="mt-8 font-semibold text-text">Times</h2>
      <p className="mt-1 text-sm text-text-muted">{voters.length} {voters.length === 1 ? "person has" : "people have"} answered. Times in {tz}.</p>
      {voting && <AutoRefresh everyMs={10_000} forMs={600_000} labels={{ waiting: "New answers show up here by themselves.", stopped: "Refresh the page to see new answers." }} />}
      <ul className="mt-4 grid gap-3">
        {options.map((o) => {
          const by = (a: PollAnswer) => voters.filter((v) => v.votes[o.id] === a).map((v) => v.name);
          const chosen = poll.confirmedStart?.getTime() === o.startAt.getTime();
          return (
            <li key={o.id}>
              <Card className={`grid gap-3 ${o.best && deciding ? "ring-2 ring-accent" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold text-text">
                    {when(o.startAt)}
                    {o.best && deciding && <span className="ml-2 rounded bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">Best</span>}
                    {chosen && <span className="ml-2 rounded bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">Booked</span>}
                  </p>
                  <p className="text-sm text-text">{o.yes} yes · {o.ifNeeded} if needed · {o.no} no</p>
                </div>
                {voters.length > 0 && (
                  <dl className="grid gap-1 text-sm sm:grid-cols-3">
                    {(["yes", "if_needed", "no"] as const).map((a) => (
                      <div key={a}>
                        <dt className="text-text-muted">{ANSWER[a]}</dt>
                        <dd className="text-text">{by(a).join(", ") || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {deciding && o.startAt > now && <ConfirmTimeForm pollId={poll.id} optionId={o.id} label={when(o.startAt)} attendees={o.yes + o.ifNeeded} />}
              </Card>
            </li>
          );
        })}
      </ul>

      {voters.length > 0 && (
        <>
          <h2 className="mt-8 font-semibold text-text">Who answered</h2>
          <ul className="mt-2 grid gap-1">
            {voters.map((v) => (
              <li key={v.id} className="text-sm text-text">
                {v.name} · <a href={`mailto:${v.email}`} className="text-accent underline">{v.email}</a>{v.phone && ` · ${v.phone}`}
                {v.bookingId && <> · <Link href={`/dashboard/bookings/${v.bookingId}`} className="font-semibold text-accent underline">See booking</Link></>}
              </li>
            ))}
          </ul>
        </>
      )}

      {deciding && (
        <form action={cancelPollAction} className="mt-10">
          <input type="hidden" name="pollId" value={poll.id} />
          <Button type="submit" variant="ghost" size="sm">Cancel this poll</Button>
          <p className="mt-1 text-sm text-text-muted">Releases the times and books nothing. People who answered aren&apos;t emailed.</p>
        </form>
      )}
    </div>
  );
}
