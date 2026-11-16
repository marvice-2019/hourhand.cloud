"use client";

import { useActionState, useState } from "react";
import { createOneOff, createSingleUseLink, type LinkFormState } from "@/app/dashboard/links/actions";
import type { VideoAvailability } from "@/lib/video/gate";
import type { ZoomSetup } from "@/lib/zoom/connection";
import { CopyLinkButton } from "./CopyLinkButton";
import { ZoomHint } from "./ZoomHint";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";
import { useHostI18n } from "./HostI18nProvider";
import type { HostKey } from "@/lib/i18n/host";

const idle: LinkFormState = { status: "idle" };
const selectClasses = `mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;

/** The new link, shown once: it isn't stored anywhere it could be read back. */
function CreatedLink({ path }: { path: string }) {
  const { t } = useHostI18n();
  return (
    <div className="grid gap-2 rounded-md bg-success-bg p-4" role="status">
      <p className="font-semibold text-text">{t("links.ready")}</p>
      <code className="break-all rounded bg-card px-2 py-1 text-sm text-text">{path}</code>
      <div><CopyLinkButton path={path} /></div>
    </div>
  );
}

export function SingleUseLinkForm({ eventTypes }: { eventTypes: { id: string; name: string }[] }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(createSingleUseLink, idle);
  if (eventTypes.length === 0) return <p className="text-text-muted">{t("links.noEventTypes")}</p>;
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div>
        <Label htmlFor="link-event">{t("links.eventType")}</Label>
        <select id="link-event" name="eventTypeId" className={selectClasses} defaultValue={eventTypes[0].id}>
          {eventTypes.map((et) => <option key={et.id} value={et.id}>{et.name}</option>)}
        </select>
      </div>
      <div>
        <Label htmlFor="link-label">{t("links.noteForYourself")}</Label>
        <Input id="link-label" name="label" maxLength={100} placeholder={t("links.noteForYourselfPlaceholder")} />
      </div>
      {state.status === "error" && <p className="text-danger" role="alert">{state.message}</p>}
      {state.status === "created" && <CreatedLink path={state.path} />}
      <div><Button type="submit" loading={pending}>{t("links.makeSingleUse")}</Button></div>
    </form>
  );
}

/** Each place to meet: a product name as written, or a line from the catalogue; `needs` labels the value the host fills in. */
const LOCATIONS: { kind: string; brand?: string; label?: HostKey; needs?: HostKey }[] = [
  { kind: "google_meet", brand: "Google Meet" },
  { kind: "teams", brand: "Microsoft Teams" },
  { kind: "zoom", brand: "Zoom" },
  { kind: "hourhand_video", label: "links.locHourhandVideo" },
  { kind: "phone_host_calls", label: "links.locPhoneHostCalls" },
  { kind: "phone_guest_calls", label: "links.locPhoneGuestCalls", needs: "links.needsPhone" },
  { kind: "in_person", label: "links.locInPerson", needs: "links.needsAddress" },
  { kind: "custom", label: "links.locCustom", needs: "links.needsDetails" },
];

export function OneOffForm({ timeZone, zoomSetup = "not_configured", video = "not_set_up" }: { timeZone: string; zoomSetup?: ZoomSetup; video?: VideoAvailability }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState(createOneOff, idle);
  const [rows, setRows] = useState<number[]>([0, 1, 2]);
  const [next, setNext] = useState(3);
  const [kind, setKind] = useState("google_meet");
  const needs = LOCATIONS.find((l) => l.kind === kind)?.needs;
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div><Label htmlFor="oo-name">{t("links.whatFor")}</Label><Input id="oo-name" name="name" required maxLength={100} placeholder={t("links.whatForPlaceholder")} /></div>
      <div><Label htmlFor="oo-duration">{t("links.length")}</Label><Input id="oo-duration" name="durationMinutes" inputMode="numeric" defaultValue="30" className="max-w-32" /></div>
      <div>
        <Label htmlFor="oo-location">{t("links.whereYouMeet")}</Label>
        <select id="oo-location" name="locationKind" className={selectClasses} value={kind} onChange={(e) => setKind(e.target.value)}>
          {LOCATIONS.map((l) => <option key={l.kind} value={l.kind}>{l.label ? t(l.label) : l.brand}</option>)}
        </select>
        {kind === "teams" && <p className="mt-1 text-sm text-text-muted">{t("links.teamsHint")}</p>}
        {kind === "hourhand_video" && (
          <p className={`mt-1 text-sm ${video === "ready" ? "text-text-muted" : "text-danger"}`}>
            {t(video === "ready" ? "links.videoReady" : video === "plan" ? "links.videoNeedsPlan" : "links.videoNotSetUp")}
          </p>
        )}
        {kind === "zoom" && <ZoomHint setup={zoomSetup} />}
      </div>
      {needs && <div><Label htmlFor="oo-location-value">{t(needs)}</Label><Input id="oo-location-value" name="locationValue" /></div>}
      <div><Label htmlFor="oo-description">{t("links.noteForGuest")}</Label><Input id="oo-description" name="description" maxLength={2000} /></div>
      <fieldset className="grid gap-2">
        <legend className="font-semibold text-text">{t("links.timesToOffer")}</legend>
        <p className="text-sm text-text-muted">{t("links.timesHint", { zone: timeZone })}</p>
        {rows.map((row, i) => (
          <div key={row} className="flex items-center gap-2">
            <Input id={`oo-time-${row}`} aria-label={t("links.timeN", { n: i + 1 })} type="datetime-local" name="times" className="max-w-64" />
            {rows.length > 1 && (
              <Button variant="ghost" size="sm" aria-label={t("links.removeTimeN", { n: i + 1 })} onClick={() => setRows(rows.filter((r) => r !== row))}>{t("common.remove")}</Button>
            )}
          </div>
        ))}
        {rows.length < 20 && (
          <div><Button variant="secondary" size="sm" onClick={() => { setRows([...rows, next]); setNext(next + 1); }}>{t("links.addTime")}</Button></div>
        )}
      </fieldset>
      {state.status === "error" && <p className="text-danger" role="alert">{state.message}</p>}
      {state.status === "created" && <CreatedLink path={state.path} />}
      <div><Button type="submit" loading={pending}>{t("links.makeOneOff")}</Button></div>
    </form>
  );
}
