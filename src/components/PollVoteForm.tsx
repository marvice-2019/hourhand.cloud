"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDeviceZone } from "./SlotPicker";
import { useTimeFormat } from "./useTimeFormat";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { formatDate, formatTime, zoneName } from "@/lib/format";
import type { Locale } from "@/lib/i18n/guest";
import { pt, type PollKey } from "@/lib/i18n/poll";

type Answer = "yes" | "if_needed" | "no";
const ANSWERS: { value: Answer; key: PollKey; tone: string }[] = [
  { value: "yes", key: "yes", tone: "peer-checked:border-success peer-checked:bg-success-bg peer-checked:text-success" },
  { value: "if_needed", key: "ifNeeded", tone: "peer-checked:border-accent peer-checked:bg-surface peer-checked:text-text" },
  { value: "no", key: "no", tone: "peer-checked:border-text-muted peer-checked:bg-surface peer-checked:text-text-muted" },
];

export interface PollOptionView { id: string; startAt: string; yes: number; ifNeeded: number; best: boolean }

/**
 * The invitee's answers: yes, if needed or no for every proposed time, each a native radio group (arrow keys move within
 * it, the time is its legend), then name and email. With `edit`, the signed link's voter is changing their answers.
 */
export function PollVoteForm({ token, locale, hostTimezone, options, edit }: {
  token: string; locale: Locale; hostTimezone: string; options: PollOptionView[];
  edit: { token: string; name: string; email: string; phone: string | null; votes: Record<string, Answer> } | null;
}) {
  const router = useRouter();
  const zone = useDeviceZone() ?? hostTimezone;
  const cycle = useTimeFormat();
  const [votes, setVotes] = useState<Record<string, Answer>>(edit?.votes ?? {});
  const [fields, setFields] = useState<Record<string, PollKey>>({});
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (iso: string) => `${formatDate(new Date(iso), zone, locale)}, ${formatTime(new Date(iso), zone, cycle, locale)}`;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const missing = Object.fromEntries(options.filter((o) => !votes[o.id]).map((o) => [`votes.${o.id}`, "errAnswer" as PollKey]));
    if (Object.keys(missing).length > 0) {
      setFields(missing);
      setResult({ tone: "error", text: pt(locale, "errCheck") });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/polls/vote", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token, name: form.get("name"), email: edit ? edit.email : form.get("email"), phone: form.get("phone"), timezone: zone, locale, votes,
          editToken: edit?.token ?? null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setFields({});
        setResult({ tone: "ok", text: body.status === "exists" ? pt(locale, "exists") : edit ? pt(locale, "updated") : pt(locale, "saved", { name: String(form.get("name")) }) });
        router.refresh();
      } else if (res.status === 400 && body.fields) {
        setFields(body.fields);
        setResult({ tone: "error", text: pt(locale, body.fields.votes ? "errStale" : "errCheck") });
      } else {
        const key: PollKey = res.status === 429 ? "tooMany" : res.status === 409 ? "closedTitle" : body.error === "bad_edit_link" ? "errEditLink" : "failed";
        setResult({ tone: "error", text: pt(locale, key) });
        if (res.status === 409) router.refresh();
      }
    } catch {
      setResult({ tone: "error", text: pt(locale, "offline") });
    } finally {
      setBusy(false);
    }
  }

  const err = (k: string) => (fields[k] ? pt(locale, fields[k]) : null);

  return (
    <form onSubmit={submit} noValidate className="mt-6 grid gap-6">
      <p className="text-sm text-text-muted">{pt(locale, "timesIn", { zone: zoneName(zone) })}</p>
      <div className="grid gap-4">
        {options.map((o) => {
          const error = err(`votes.${o.id}`);
          const time = label(o.startAt);
          return (
            <fieldset key={o.id} className="grid gap-2 rounded-lg border border-border p-4" aria-describedby={`${o.id}-counts${error ? ` ${o.id}-err` : ""}`} aria-invalid={error ? true : undefined}>
              <legend className="px-1 font-semibold text-text">
                <span className="sr-only">{pt(locale, "answerFor", { time })}</span>
                <span aria-hidden="true">{time}</span>
              </legend>
              <p id={`${o.id}-counts`} className="text-sm text-text-muted">
                {pt(locale, "counts", { yes: o.yes, ifNeeded: o.ifNeeded })}{o.best && <> · <span className="font-semibold text-success">{pt(locale, "best")}</span></>}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {ANSWERS.map((a) => (
                  <label key={a.value} className="relative">
                    <input type="radio" name={`vote-${o.id}`} value={a.value} checked={votes[o.id] === a.value}
                      onChange={() => { setVotes({ ...votes, [o.id]: a.value }); setFields((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== `votes.${o.id}`))); }}
                      className="peer sr-only" />
                    <span className={`flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border-input bg-card px-2 text-center text-sm font-semibold text-text peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${a.tone}`}>
                      {pt(locale, a.key)}
                    </span>
                  </label>
                ))}
              </div>
              {error && <p id={`${o.id}-err`} className="text-sm text-danger">{error}</p>}
            </fieldset>
          );
        })}
      </div>

      <fieldset className="grid max-w-md gap-4">
        <legend className="font-semibold text-text">{pt(locale, "yourDetails")}</legend>
        {edit && <p className="text-sm text-text" role="status">{pt(locale, "editing", { email: edit.email })}</p>}
        <div>
          <Label htmlFor="poll-name">{pt(locale, "name")}</Label>
          <Input id="poll-name" name="name" required maxLength={100} autoComplete="name" defaultValue={edit?.name ?? ""} aria-invalid={fields.name ? true : undefined} aria-describedby={fields.name ? "poll-name-err" : undefined} />
          {fields.name && <p id="poll-name-err" className="mt-1 text-sm text-danger">{err("name")}</p>}
        </div>
        {!edit && (
          <div>
            <Label htmlFor="poll-email">{pt(locale, "email")}</Label>
            <Input id="poll-email" name="email" type="email" required maxLength={254} autoComplete="email" aria-invalid={fields.email ? true : undefined} aria-describedby={`poll-email-hint${fields.email ? " poll-email-err" : ""}`} />
            <p id="poll-email-hint" className="mt-1 text-sm text-text-muted">{pt(locale, "emailHint")}</p>
            {fields.email && <p id="poll-email-err" className="mt-1 text-sm text-danger">{err("email")}</p>}
          </div>
        )}
        <div>
          <Label htmlFor="poll-phone">{pt(locale, "phone")}</Label>
          <Input id="poll-phone" name="phone" type="tel" maxLength={20} autoComplete="tel" defaultValue={edit?.phone ?? ""} aria-invalid={fields.phone ? true : undefined} aria-describedby={fields.phone ? "poll-phone-err" : undefined} />
          {fields.phone && <p id="poll-phone-err" className="mt-1 text-sm text-danger">{err("phone")}</p>}
        </div>
      </fieldset>

      <div aria-live="polite">
        {result && <p role={result.tone === "error" ? "alert" : "status"} className={result.tone === "error" ? "text-danger" : "rounded-md bg-success-bg p-3 text-text"}>{result.text}</p>}
      </div>
      <div><Button type="submit" loading={busy}>{busy ? pt(locale, "sending") : edit ? pt(locale, "update") : pt(locale, "send")}</Button></div>
    </form>
  );
}
