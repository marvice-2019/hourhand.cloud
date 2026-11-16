import Link from "next/link";
import { ActiveSwitch } from "@/components/ActiveSwitch";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { store, type LocationKind } from "@/lib/data";
import { getHostContext, requireHost } from "@/lib/auth/session";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";

const locationLabel: Record<LocationKind, HostKey> = {
  google_meet: "eventTypes.locGoogleMeet",
  zoom: "eventTypes.locZoom",
  teams: "eventTypes.locTeams",
  phone_host_calls: "eventTypes.locPhoneHostCalls",
  phone_guest_calls: "eventTypes.locPhoneGuestCalls",
  in_person: "eventTypes.locInPerson",
  custom: "eventTypes.locCustomShort",
  ask_guest: "eventTypes.locAskGuest",
  hourhand_video: "eventTypes.locHourhandVideoShort",
};

export const dynamic = "force-dynamic";

export default async function EventTypesPage() {
  const user = await requireHost();
  const { t, money } = await getHostI18n();
  // Importing uses the owner's own Calendly or Cal.com token, so a Duo second person doesn't get the link.
  const acting = (await getHostContext())?.acting === true;
  const eventTypes = [...(await store.listEventTypes(user.id))].sort((a, b) => a.position - b.position);
  const locations = await Promise.all(eventTypes.map((et) => store.listEventLocations(user.id, et.id)));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-xl text-text">{t("eventTypes.title")}</h1>
          <p className="mt-2 text-text-muted">{t("eventTypes.intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!acting && <Link href="/dashboard/event-types/import" className={buttonClasses({ variant: "secondary" })}>{t("eventTypes.importLink")}</Link>}
          <Link href="/dashboard/event-types/templates" className={buttonClasses({ variant: "secondary" })}>{t("intake.templatesLink")}</Link>
          <Link href="/dashboard/event-types/new" className={buttonClasses()}>{t("eventTypes.new")}</Link>
        </div>
      </div>

      {eventTypes.length === 0 ? (
        <Card className="mt-6">
          <h2 className="font-display text-lg text-text">{t("eventTypes.emptyTitle")}</h2>
          <p className="mt-2 text-text-muted">{t("eventTypes.emptyBody")}</p>
          <Link href="/dashboard/event-types/new" className={`mt-4 ${buttonClasses()}`}>{t("eventTypes.emptyCta")}</Link>
        </Card>
      ) : (
        <ul className="mt-6 grid gap-4 md:grid-cols-2">
          {eventTypes.map((et, i) => {
            const path = `/${user.slug}/${et.slug}`;
            const first = locations[i][0];
            return (
              <li key={et.id}>
                <Card className="flex h-full flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-display text-lg text-text">
                      <Link href={`/dashboard/event-types/${et.id}`} className={`rounded-sm hover:underline ${focusRing}`}>{et.name}</Link>
                    </h2>
                    <ActiveSwitch id={et.id} name={et.name} active={et.active} />
                  </div>
                  <p className="text-sm text-text-muted">{t("common.minutes", { n: et.durationMinutes })}{et.priceMinor !== null && ` · ${money(et.priceMinor, et.currency)}`} · {first ? t(locationLabel[first.kind]) : t("eventTypes.noLocation")}</p>
                  <div className="mt-auto flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs text-text-muted">{path}</span>
                    <CopyLinkButton path={path} />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
