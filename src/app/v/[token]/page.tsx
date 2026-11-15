import type { Metadata } from "next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { PollVoteForm } from "@/components/PollVoteForm";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime, zoneName } from "@/lib/format";
import { LOCATION_KEYS, resolveLocale, t } from "@/lib/i18n/guest";
import { pt } from "@/lib/i18n/poll";
import { pollByToken, pollLinkKey, voterForEdit } from "@/lib/polls/polls";

export const dynamic = "force-dynamic";
// The link is shared with a group, not the world: keep it out of search results and referrer headers.
export const metadata: Metadata = { title: "Find a time · Hourhand", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** A meeting poll's voting page. No account: invitees answer with their name and email; an emailed signed link edits. */
export default async function PollVotePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string; edit?: string }> }) {
  const { token } = await params;
  const { lang, edit } = await searchParams;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const now = new Date();
  const found = pool ? await pollByToken(pool, token, now) : null;
  const locale = resolveLocale(lang, found?.host.locale);
  if (!found) {
    return (
      <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
        <h1 className="font-display text-xl text-text">{pt(locale, "notFoundTitle")}</h1>
        <p className="mt-2 text-text-muted">{pt(locale, "notFoundBody")}</p>
      </main>
    );
  }
  const { poll, host, options } = found;
  let editing: Awaited<ReturnType<typeof voterForEdit>> = null;
  let badLink = false;
  if (typeof edit === "string" && edit && found.open) {
    try {
      editing = await voterForEdit(pool!, token, edit, pollLinkKey(), now);
    } catch {
      editing = null; // no signing key configured: treat it as a link that doesn't work
    }
    badLink = editing === null;
  }
  const hostTz = host.timezone;
  const where = `${t(locale, LOCATION_KEYS[poll.locationKind])}${poll.locationValue ? `: ${poll.locationValue}` : ""}`;

  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <LanguageSwitcher locale={locale} path={`/v/${token}`} params={{ edit: typeof edit === "string" ? edit : undefined }} />
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">{poll.title}</h1>
      <p className="mt-2 text-text-muted">{pt(locale, "duration", { n: poll.durationMinutes })} · {pt(locale, "where")}: {where}</p>
      {poll.description && <p className="mt-2 max-w-xl whitespace-pre-line text-text">{poll.description}</p>}

      {found.open ? (
        <>
          <p className="mt-4 max-w-xl text-text">{pt(locale, "intro", { host: host.name })}</p>
          <p className="mt-1 text-sm text-text-muted">
            {pt(locale, "closes", { date: `${formatDate(poll.deadline, hostTz, locale)}, ${formatTime(poll.deadline, hostTz, host.timeFormat, locale)} ${zoneName(hostTz)}` })}
            {" · "}{pt(locale, "answered", { n: found.voterCount })}
          </p>
          {badLink && <p role="alert" className="mt-4 max-w-xl rounded-md bg-danger-bg p-3 text-sm text-danger">{pt(locale, "errEditLink")}</p>}
          <PollVoteForm
            token={token} locale={locale} hostTimezone={hostTz}
            options={options.map((o) => ({ id: o.id, startAt: o.startAt.toISOString(), yes: o.yes, ifNeeded: o.ifNeeded, best: o.best }))}
            edit={editing && typeof edit === "string" ? { token: edit, name: editing.name, email: editing.email, phone: editing.phone, votes: editing.votes } : null}
          />
        </>
      ) : poll.status === "confirmed" && poll.confirmedStart ? (
        <section className="mt-6 max-w-xl" role="status">
          <h2 className="font-semibold text-text">{pt(locale, "confirmedTitle")}</h2>
          <p className="mt-1 text-text">{pt(locale, "confirmedBody", { host: host.name, when: `${formatDate(poll.confirmedStart, hostTz, locale)}, ${formatTime(poll.confirmedStart, hostTz, host.timeFormat, locale)} ${zoneName(hostTz)}` })}</p>
        </section>
      ) : poll.status === "cancelled" ? (
        <section className="mt-6 max-w-xl" role="status">
          <h2 className="font-semibold text-text">{pt(locale, "cancelledTitle")}</h2>
          <p className="mt-1 text-text">{pt(locale, "cancelledBody", { host: host.name })}</p>
        </section>
      ) : (
        <section className="mt-6 max-w-xl" role="status">
          <h2 className="font-semibold text-text">{pt(locale, "closedTitle")}</h2>
          <p className="mt-1 text-text">{pt(locale, "closedBody", { host: host.name })}</p>
        </section>
      )}
    </main>
  );
}
