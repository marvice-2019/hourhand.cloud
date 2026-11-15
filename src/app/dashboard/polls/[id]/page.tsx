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
import type { LocationKind } from "@/lib/data/types";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { acceptsVotes, pollForHost, type PollAnswer } from "@/lib/polls/polls";

export const dynamic = "force-dynamic";

const ANSWER: Record<PollAnswer, HostKey> = { yes: "polls.answerYes", if_needed: "polls.answerIfNeeded", no: "polls.answerNo" };

/** How the location reads, as the guest pages word it (src/lib/location-labels.ts). */
const LOCATION: Record<LocationKind, HostKey> = {
  google_meet: "polls.locGoogleMeet", zoom: "polls.locZoom", teams: "polls.locTeams", phone_host_calls: "polls.locPhoneHostCallsGuest",
  phone_guest_calls: "polls.locPhoneGuestCallsGuest", in_person: "polls.locInPerson", custom: "polls.locCustomGuest", ask_guest: "polls.locAskGuest",
};

export default async function PollPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const user = await requireHost();
  const { t, tNodes, date, time } = await getHostI18n();
  const { id } = await params;
  const { done, error } = await searchParams;
  const found = authEnabled() ? await pollForHost(getPool(process.env.DATABASE_URL as string), user.id, id) : null;
  if (!found) notFound();
  const { poll, options, voters } = found;
  const now = new Date();
  const tz = user.timezone;
  const when = (d: Date) => t("polls.when", { date: date(d, tz), time: time(d, tz, user.timeFormat) });
  const voting = acceptsVotes(poll, now);
  const deciding = poll.status === "open" || poll.status === "closed";
  const path = `/v/${poll.token}`;

  return (
    <div>
      <Link href="/dashboard/polls" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("polls.title")}</Link>
      <h1 className="font-display text-xl text-text">{poll.title}</h1>
      <p className="mt-2 text-text-muted">
        {poll.locationValue
          ? t("polls.metaWithValue", { duration: t("common.minutes", { n: poll.durationMinutes }), location: t(LOCATION[poll.locationKind]), value: poll.locationValue })
          : t("polls.meta", { duration: t("common.minutes", { n: poll.durationMinutes }), location: t(LOCATION[poll.locationKind]) })}
      </p>
      {poll.description && <p className="mt-2 max-w-xl text-text">{poll.description}</p>}

      {done === "created" && <p role="status" className="mt-4 rounded-md bg-success-bg p-3 text-sm text-text">{t("polls.doneCreated")}</p>}
      {done === "confirmed" && <p role="status" className="mt-4 rounded-md bg-success-bg p-3 text-sm text-text">{t("polls.doneConfirmed")}</p>}
      {done === "cancelled" && <p role="status" className="mt-4 rounded-md bg-surface p-3 text-sm text-text">{t("polls.doneCancelled")}</p>}
      {error === "not_cancellable" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("polls.errNotCancellable")}</p>}

      <Card className="mt-6 grid max-w-xl gap-3">
        {voting && (
          <>
            <p className="font-semibold text-text">{t("polls.votingOpen")}</p>
            <code className="break-all rounded bg-surface px-2 py-1 text-sm text-text">{path}</code>
            <div><CopyLinkButton path={path} /></div>
            <p className="text-sm text-text-muted">
              {t("polls.closes", { when: when(poll.deadline) })}{" "}
              {t(poll.holdTimes ? "polls.held" : "polls.notHeld")}
            </p>
          </>
        )}
        {deciding && !voting && <p className="text-text">{tNodes("polls.votingClosed", { closed: <span className="font-semibold">{t("polls.votingClosedBold")}</span> })}</p>}
        {poll.status === "confirmed" && poll.confirmedStart && <p className="text-text">{tNodes("polls.bookedFor", { booked: <span className="font-semibold">{t("polls.bookedForBold", { when: when(poll.confirmedStart) })}</span> })}</p>}
        {poll.status === "cancelled" && <p className="text-text-muted">{t("polls.wasCancelled")}</p>}
      </Card>

      <h2 className="mt-8 font-semibold text-text">{t("polls.times")}</h2>
      <p className="mt-1 text-sm text-text-muted">{t(voters.length === 1 ? "polls.answeredOne" : "polls.answeredMany", { n: voters.length, zone: tz })}</p>
      {voting && <AutoRefresh everyMs={10_000} forMs={600_000} labels={{ waiting: t("polls.refreshWaiting"), stopped: t("polls.refreshStopped") }} />}
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
                    {o.best && deciding && <span className="ml-2 rounded bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">{t("polls.best")}</span>}
                    {chosen && <span className="ml-2 rounded bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">{t("polls.booked")}</span>}
                  </p>
                  <p className="text-sm text-text">{t("polls.tally", { yes: o.yes, ifNeeded: o.ifNeeded, no: o.no })}</p>
                </div>
                {voters.length > 0 && (
                  <dl className="grid gap-1 text-sm sm:grid-cols-3">
                    {(["yes", "if_needed", "no"] as const).map((a) => (
                      <div key={a}>
                        <dt className="text-text-muted">{t(ANSWER[a])}</dt>
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
          <h2 className="mt-8 font-semibold text-text">{t("polls.whoAnswered")}</h2>
          <ul className="mt-2 grid gap-1">
            {voters.map((v) => (
              <li key={v.id} className="text-sm text-text">
                {v.name} · <a href={`mailto:${v.email}`} className="text-accent underline">{v.email}</a>{v.phone && ` · ${v.phone}`}
                {v.bookingId && <> · <Link href={`/dashboard/bookings/${v.bookingId}`} className="font-semibold text-accent underline">{t("polls.seeBooking")}</Link></>}
              </li>
            ))}
          </ul>
        </>
      )}

      {deciding && (
        <form action={cancelPollAction} className="mt-10">
          <input type="hidden" name="pollId" value={poll.id} />
          <Button type="submit" variant="ghost" size="sm">{t("polls.cancelPoll")}</Button>
          <p className="mt-1 text-sm text-text-muted">{t("polls.cancelHint")}</p>
        </form>
      )}
    </div>
  );
}
