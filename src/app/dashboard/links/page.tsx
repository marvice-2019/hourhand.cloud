import Link from "next/link";
import { revokeLink } from "./actions";
import { LocalTime } from "@/components/LocalTime";
import { SingleUseLinkForm } from "@/components/LinkForms";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requireHost } from "@/lib/auth/session";
import { store } from "@/lib/data";
import type { BookingLink } from "@/lib/data/types";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

const STATE: Record<BookingLink["state"], { label: HostKey; className: string }> = {
  open: { label: "links.stateOpen", className: "bg-success-bg text-success" },
  used: { label: "links.stateUsed", className: "bg-surface text-text" },
  expired: { label: "links.stateExpired", className: "bg-surface text-text-muted" },
  revoked: { label: "links.stateRevoked", className: "bg-surface text-text-muted" },
};

export default async function LinksPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const user = await requireHost();
  const { t, tNodes, date } = await getHostI18n();
  const { done, error } = await searchParams;
  const now = new Date();
  const [links, eventTypes] = await Promise.all([store.listBookingLinks(user.id, now), store.listEventTypes(user.id)]);
  // One-off meetings aren't in the event types list; look their names up for the rows that need them.
  const names = new Map(eventTypes.map((et) => [et.id, et.name]));
  for (const id of new Set(links.map((l) => l.eventTypeId).filter((id) => !names.has(id)))) {
    const et = await store.getEventType(user.id, id);
    if (et) names.set(id, et.kind === "one_off" ? t("links.oneOffName", { name: et.name }) : et.name);
  }
  const tz = user.timezone;

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("links.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {t("links.intro")}
      </p>
      {done === "revoked" && <p role="status" className="mt-4 rounded-md bg-surface p-3 text-sm text-text">{t("links.revoked")}</p>}
      {error === "not_revocable" && <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("links.notRevocable")}</p>}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-text">{t("links.newSingleUse")}</h2>
          <div className="mt-4"><SingleUseLinkForm eventTypes={eventTypes.filter((et) => et.active).map(({ id, name }) => ({ id, name }))} /></div>
        </Card>
        <Card>
          <h2 className="font-semibold text-text">{t("links.newOneOff")}</h2>
          <p className="mt-2 text-text-muted">{t("links.oneOffCardIntro")}</p>
          <Link href="/dashboard/links/new" className={`mt-4 ${buttonClasses({ variant: "secondary" })}`}>{t("links.setUpOneOff")}</Link>
        </Card>
      </div>

      <h2 className="mt-10 font-semibold text-text">{t("links.yourLinks")}</h2>
      {links.length === 0 ? (
        <p className="mt-2 text-text-muted">{t("links.none")}</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {links.map((l) => (
            <li key={l.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-text">
                    {names.get(l.eventTypeId) ?? t("links.eventTypeRemoved")}
                    <span className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${STATE[l.state].className}`}>{t(STATE[l.state].label)}</span>
                  </p>
                  {l.label && <p className="text-sm text-text">{l.label}</p>}
                  <p className="text-sm text-text-muted">
                    {t("links.made", { date: date(l.createdAt, tz) })}
                    {l.usedBy && tNodes("links.bookedBy", { name: l.usedBy.guestName, date: date(l.usedBy.startAt, tz), time: <LocalTime date={l.usedBy.startAt} tz={tz} /> })}
                    {l.state === "open" && l.expiresAt && t("links.expires", { date: date(l.expiresAt, tz) })}
                  </p>
                </div>
                {l.state === "open" && (
                  <form action={revokeLink}>
                    <input type="hidden" name="linkId" value={l.id} />
                    <Button type="submit" variant="ghost" size="sm">{t("links.revoke")}</Button>
                  </form>
                )}
                {l.usedBy && <Link href={`/dashboard/bookings/${l.usedBy.bookingId}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("links.seeBooking")}</Link>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
