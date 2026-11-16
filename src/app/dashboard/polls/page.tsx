import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { acceptsVotes, listPolls, type PollStatus } from "@/lib/polls/polls";

export const dynamic = "force-dynamic";

const STATE: Record<PollStatus | "awaiting", { label: HostKey; className: string }> = {
  open: { label: "polls.stateVoting", className: "bg-success-bg text-success" },
  awaiting: { label: "polls.statePick", className: "bg-surface text-text" },
  closed: { label: "polls.statePick", className: "bg-surface text-text" },
  confirmed: { label: "polls.stateBooked", className: "bg-surface text-text" },
  cancelled: { label: "polls.stateCancelled", className: "bg-surface text-text-muted" },
};

export default async function PollsPage() {
  const user = await requireHost();
  const { t, date, time } = await getHostI18n();
  const now = new Date();
  const polls = authEnabled() ? await listPolls(getPool(process.env.DATABASE_URL as string), user.id) : [];
  const tz = user.timezone;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("polls.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {t("polls.intro")}
      </p>
      {authEnabled() ? (
        <Link href="/dashboard/polls/new" className={`mt-4 ${buttonClasses()}`}>{t("polls.newPoll")}</Link>
      ) : (
        <p className="mt-4 text-text-muted">{t("polls.noDb")}</p>
      )}

      <h2 className="mt-10 font-semibold text-text">{t("polls.yourPolls")}</h2>
      {polls.length === 0 ? (
        <p className="mt-2 text-text-muted">{t("polls.none")}</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {polls.map((p) => {
            const state = p.status === "open" && !acceptsVotes(p, now) ? STATE.awaiting : STATE[p.status];
            const one = p.voters === 1;
            const counts = { times: p.times, n: p.voters };
            const summary = p.status === "open" && acceptsVotes(p, now)
              ? t(one ? "polls.summaryOneCloses" : "polls.summaryManyCloses", { ...counts, date: date(p.deadline, tz), time: time(p.deadline, tz, user.timeFormat) })
              : p.confirmedStart
                ? t(one ? "polls.summaryOneBooked" : "polls.summaryManyBooked", { ...counts, date: date(p.confirmedStart, tz), time: time(p.confirmedStart, tz, user.timeFormat) })
                : t(one ? "polls.summaryOne" : "polls.summaryMany", counts);
            return (
              <li key={p.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-text">
                      {p.title}
                      <span className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${state.className}`}>{t(state.label)}</span>
                    </p>
                    <p className="text-sm text-text-muted">{summary}</p>
                  </div>
                  <Link href={`/dashboard/polls/${p.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
                    {t(p.status === "open" || p.status === "closed" ? "polls.seeAnswers" : "polls.details")}
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
