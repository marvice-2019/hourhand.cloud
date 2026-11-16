"use client";

import { useActionState, useState } from "react";
import { confirmPollAction, createPollAction, type ConfirmState, type PollFormState } from "@/app/dashboard/polls/actions";
import type { HostKey } from "@/lib/i18n/host";
import { useHostI18n } from "./HostI18nProvider";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const selectClasses = `mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;
const MIN_TIMES = 2;
const MAX_TIMES = 8;

const LOCATIONS: { kind: string; label: HostKey; needs?: HostKey }[] = [
  { kind: "google_meet", label: "polls.locGoogleMeet" },
  { kind: "teams", label: "polls.locTeams" },
  { kind: "zoom", label: "polls.locZoom" },
  { kind: "phone_host_calls", label: "polls.locPhoneHostCalls" },
  { kind: "phone_guest_calls", label: "polls.locPhoneGuestCalls", needs: "polls.needsPhone" },
  { kind: "in_person", label: "polls.locInPerson", needs: "polls.needsAddress" },
  { kind: "custom", label: "polls.locCustom", needs: "polls.needsDetails" },
];

export function PollForm({ timeZone, freeLimitReached }: { timeZone: string; freeLimitReached: boolean }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState<PollFormState, FormData>(createPollAction, { status: "idle" });
  const [rows, setRows] = useState<number[]>([0, 1, 2]);
  const [next, setNext] = useState(3);
  const [kind, setKind] = useState("google_meet");
  const needs = LOCATIONS.find((l) => l.kind === kind)?.needs;
  return (
    <form action={action} className="grid max-w-md gap-4">
      {freeLimitReached && (
        <p className="rounded-md bg-surface p-3 text-sm text-text" role="status">
          {t("polls.freeLimitReached")}
        </p>
      )}
      <div><Label htmlFor="poll-title">{t("polls.whatFor")}</Label><Input id="poll-title" name="title" required maxLength={100} placeholder={t("polls.whatForPlaceholder")} /></div>
      <div><Label htmlFor="poll-duration">{t("polls.length")}</Label><Input id="poll-duration" name="durationMinutes" inputMode="numeric" defaultValue="60" className="max-w-32" /></div>
      <div>
        <Label htmlFor="poll-location">{t("polls.whereYouMeet")}</Label>
        <select id="poll-location" name="locationKind" className={selectClasses} value={kind} onChange={(e) => setKind(e.target.value)}>
          {LOCATIONS.map((l) => <option key={l.kind} value={l.kind}>{t(l.label)}</option>)}
        </select>
      </div>
      {needs && <div><Label htmlFor="poll-location-value">{t(needs)}</Label><Input id="poll-location-value" name="locationValue" /></div>}
      <div><Label htmlFor="poll-description">{t("polls.noteForInvitees")}</Label><Input id="poll-description" name="description" maxLength={2000} /></div>
      <fieldset className="grid gap-2">
        <legend className="font-semibold text-text">{t("polls.timesToPropose", { min: MIN_TIMES, max: MAX_TIMES })}</legend>
        <p className="text-sm text-text-muted">{t("polls.timesHint", { zone: timeZone })}</p>
        {rows.map((row, i) => (
          <div key={row} className="flex items-center gap-2">
            <Input id={`poll-time-${row}`} aria-label={t("polls.timeN", { n: i + 1 })} type="datetime-local" name="times" className="max-w-64" />
            {rows.length > MIN_TIMES && (
              <Button variant="ghost" size="sm" aria-label={t("polls.removeTimeN", { n: i + 1 })} onClick={() => setRows(rows.filter((r) => r !== row))}>{t("common.remove")}</Button>
            )}
          </div>
        ))}
        {rows.length < MAX_TIMES && (
          <div><Button variant="secondary" size="sm" onClick={() => { setRows([...rows, next]); setNext(next + 1); }}>{t("polls.addTime")}</Button></div>
        )}
      </fieldset>
      <div>
        <Label htmlFor="poll-deadline">{t("polls.deadline")}</Label>
        <Input id="poll-deadline" name="deadline" type="datetime-local" className="max-w-64" aria-describedby="poll-deadline-hint" />
        <p id="poll-deadline-hint" className="mt-1 text-sm text-text-muted">{t("polls.deadlineHint")}</p>
      </div>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="holdTimes" defaultChecked className={`mt-1 size-5 ${focusRing}`} aria-describedby="poll-hold-hint" />
        <span>
          <span className="font-semibold text-text">{t("polls.hold")}</span>
          <span id="poll-hold-hint" className="block text-sm text-text-muted">{t("polls.holdHint")}</span>
        </span>
      </label>
      {state.status === "error" && <p className="text-danger" role="alert">{state.message}</p>}
      <div><Button type="submit" loading={pending} disabled={freeLimitReached}>{t("polls.make")}</Button></div>
    </form>
  );
}

/** One click books the time for everyone who said yes or if needed; a clash is shown instead of booked. */
export function ConfirmTimeForm({ pollId, optionId, label, attendees }: { pollId: string; optionId: string; label: string; attendees: number }) {
  const { t } = useHostI18n();
  const [state, action, pending] = useActionState<ConfirmState, FormData>(confirmPollAction, { status: "idle" });
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="pollId" value={pollId} />
      <input type="hidden" name="optionId" value={optionId} />
      <div>
        <Button type="submit" size="sm" variant="secondary" loading={pending} disabled={attendees === 0} aria-label={t(attendees === 1 ? "polls.confirmAriaOne" : "polls.confirmAriaMany", { when: label, n: attendees })}>
          {t("polls.confirm")}
        </Button>
      </div>
      {state.status === "error" && (
        <div role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">
          {state.messages.map((m) => <p key={m}>{m}</p>)}
        </div>
      )}
    </form>
  );
}
