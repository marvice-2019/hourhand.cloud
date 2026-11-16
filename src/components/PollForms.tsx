"use client";

import { useActionState, useState } from "react";
import { confirmPollAction, createPollAction, type ConfirmState, type PollFormState } from "@/app/dashboard/polls/actions";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const selectClasses = `mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`;
const MIN_TIMES = 2;
const MAX_TIMES = 8;

const LOCATIONS: { kind: string; label: string; needs?: string }[] = [
  { kind: "google_meet", label: "Google Meet" },
  { kind: "teams", label: "Microsoft Teams" },
  { kind: "zoom", label: "Zoom" },
  { kind: "phone_host_calls", label: "Phone call (you call them)" },
  { kind: "phone_guest_calls", label: "Phone call (they call you)", needs: "Your phone number" },
  { kind: "in_person", label: "In person", needs: "Address" },
  { kind: "custom", label: "Somewhere else", needs: "Location details" },
];

export function PollForm({ timeZone, freeLimitReached }: { timeZone: string; freeLimitReached: boolean }) {
  const [state, action, pending] = useActionState<PollFormState, FormData>(createPollAction, { status: "idle" });
  const [rows, setRows] = useState<number[]>([0, 1, 2]);
  const [next, setNext] = useState(3);
  const [kind, setKind] = useState("google_meet");
  const needs = LOCATIONS.find((l) => l.kind === kind)?.needs;
  return (
    <form action={action} className="grid max-w-md gap-4">
      {freeLimitReached && (
        <p className="rounded-md bg-surface p-3 text-sm text-text" role="status">
          Free includes one open poll at a time, and you have one. Confirm or cancel it first, or move to Solo for as many as you like.
        </p>
      )}
      <div><Label htmlFor="poll-title">What&apos;s it for</Label><Input id="poll-title" name="title" required maxLength={100} placeholder="Batch 3 kickoff" /></div>
      <div><Label htmlFor="poll-duration">Length (minutes)</Label><Input id="poll-duration" name="durationMinutes" inputMode="numeric" defaultValue="60" className="max-w-32" /></div>
      <div>
        <Label htmlFor="poll-location">Where you meet</Label>
        <select id="poll-location" name="locationKind" className={selectClasses} value={kind} onChange={(e) => setKind(e.target.value)}>
          {LOCATIONS.map((l) => <option key={l.kind} value={l.kind}>{l.label}</option>)}
        </select>
      </div>
      {needs && <div><Label htmlFor="poll-location-value">{needs}</Label><Input id="poll-location-value" name="locationValue" /></div>}
      <div><Label htmlFor="poll-description">Note for invitees (optional)</Label><Input id="poll-description" name="description" maxLength={2000} /></div>
      <fieldset className="grid gap-2">
        <legend className="font-semibold text-text">Times to propose ({MIN_TIMES} to {MAX_TIMES})</legend>
        <p className="text-sm text-text-muted">In your time zone ({timeZone}). Invitees see them in theirs.</p>
        {rows.map((row, i) => (
          <div key={row} className="flex items-center gap-2">
            <Input id={`poll-time-${row}`} aria-label={`Time ${i + 1}`} type="datetime-local" name="times" className="max-w-64" />
            {rows.length > MIN_TIMES && (
              <Button variant="ghost" size="sm" aria-label={`Remove time ${i + 1}`} onClick={() => setRows(rows.filter((r) => r !== row))}>Remove</Button>
            )}
          </div>
        ))}
        {rows.length < MAX_TIMES && (
          <div><Button variant="secondary" size="sm" onClick={() => { setRows([...rows, next]); setNext(next + 1); }}>Add another time</Button></div>
        )}
      </fieldset>
      <div>
        <Label htmlFor="poll-deadline">Voting closes (optional)</Label>
        <Input id="poll-deadline" name="deadline" type="datetime-local" className="max-w-64" aria-describedby="poll-deadline-hint" />
        <p id="poll-deadline-hint" className="mt-1 text-sm text-text-muted">Leave it blank for 7 days from now, or the first proposed time if that is sooner. We email you when it closes so you can pick.</p>
      </div>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="holdTimes" defaultChecked className={`mt-1 size-5 ${focusRing}`} aria-describedby="poll-hold-hint" />
        <span>
          <span className="font-semibold text-text">Hold these times</span>
          <span id="poll-hold-hint" className="block text-sm text-text-muted">Nobody else can book them while voting is open. They&apos;re released when you confirm one or voting closes.</span>
        </span>
      </label>
      {state.status === "error" && <p className="text-danger" role="alert">{state.message}</p>}
      <div><Button type="submit" loading={pending} disabled={freeLimitReached}>Make the poll</Button></div>
    </form>
  );
}

/** One click books the time for everyone who said yes or if needed; a clash is shown instead of booked. */
export function ConfirmTimeForm({ pollId, optionId, label, attendees }: { pollId: string; optionId: string; label: string; attendees: number }) {
  const [state, action, pending] = useActionState<ConfirmState, FormData>(confirmPollAction, { status: "idle" });
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="pollId" value={pollId} />
      <input type="hidden" name="optionId" value={optionId} />
      <div>
        <Button type="submit" size="sm" variant="secondary" loading={pending} disabled={attendees === 0} aria-label={`Confirm ${label} for ${attendees} ${attendees === 1 ? "person" : "people"}`}>
          Confirm this time
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
