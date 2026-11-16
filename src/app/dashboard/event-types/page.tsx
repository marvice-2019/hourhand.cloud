import Link from "next/link";
import { ActiveSwitch } from "@/components/ActiveSwitch";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { formatAmount } from "@/lib/money";
import { store, type LocationKind } from "@/lib/data";
import { getHostContext, requireHost } from "@/lib/auth/session";

const locationLabel: Record<LocationKind, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  phone_host_calls: "Phone call (you call them)",
  phone_guest_calls: "Phone call (they call you)",
  in_person: "In person",
  custom: "Custom location",
  ask_guest: "Guest picks the place",
  hourhand_video: "Hourhand video",
};

export const dynamic = "force-dynamic";

export default async function EventTypesPage() {
  const user = await requireHost();
  // Importing uses the owner's own Calendly or Cal.com token, so a Duo second person doesn't get the link.
  const acting = (await getHostContext())?.acting === true;
  const eventTypes = [...(await store.listEventTypes(user.id))].sort((a, b) => a.position - b.position);
  const locations = await Promise.all(eventTypes.map((et) => store.listEventLocations(user.id, et.id)));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-xl text-text">Event types</h1>
          <p className="mt-2 text-text-muted">Each event type is a booking link people use to pick a time with you.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!acting && <Link href="/dashboard/event-types/import" className={buttonClasses({ variant: "secondary" })}>Import from Calendly / Cal.com</Link>}
          <Link href="/dashboard/event-types/new" className={buttonClasses()}>New event type</Link>
        </div>
      </div>

      {eventTypes.length === 0 ? (
        <Card className="mt-6">
          <h2 className="font-display text-lg text-text">Create your first booking link</h2>
          <p className="mt-2 text-text-muted">Pick a length and where you meet. Then share the link and people book themselves in.</p>
          <Link href="/dashboard/event-types/new" className={`mt-4 ${buttonClasses()}`}>Create a booking link</Link>
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
                  <p className="text-sm text-text-muted">{et.durationMinutes} min{et.priceMinor !== null && ` · ${formatAmount(et.priceMinor, et.currency)}`} · {first ? locationLabel[first.kind] : "No location set"}</p>
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
