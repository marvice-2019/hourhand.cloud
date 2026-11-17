"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { focusRing } from "@/components/ui/focus";
import { useDeviceZone } from "@/components/SlotPicker";
import { dayKey } from "@/lib/format";
import { t, type Locale } from "@/lib/i18n/guest";

/** The practice page's shared waitlist: pick a service and a day; any practitioner offering it who frees a time emails you. */
export function PracticeWaitlistForm({ practice, practiceName, services, locale = "en" }: {
  practice: string; practiceName: string; services: { slug: string; name: string }[]; locale?: Locale;
}) {
  const tz = useDeviceZone();
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!tz || services.length === 0) return null;
  const today = dayKey(new Date(), tz);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState("sending");
    setErrors({});
    try {
      const res = await fetch("/api/practice-waitlist", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ practice, service: f.get("service"), timezone: tz, day: f.get("day"), name: f.get("name"), email: f.get("email") }),
      });
      if (res.ok) return setState("done");
      const body = await res.json().catch(() => ({}));
      const fields = (body.fields ?? {}) as Record<string, string>;
      const mine: Record<string, string> = { name: t(locale, "errName"), email: t(locale, "errEmail"), day: t(locale, "errDay"), timezone: t(locale, "errTimezone") };
      setErrors(Object.keys(fields).length > 0 ? Object.fromEntries(Object.keys(fields).map((k) => [k, mine[k] ?? fields[k]]))
        : { form: t(locale, res.status === 429 ? "waitlistTooMany" : "waitlistFailed") });
    } catch {
      setErrors({ form: t(locale, "offline") });
    }
    setState("idle");
  }

  return (
    <details className="mt-6 rounded-md border border-border p-4">
      <summary className={`min-h-11 cursor-pointer content-center font-semibold text-text ${focusRing}`}>{t(locale, "waitlistSummary")}</summary>
      {state === "done" ? (
        <p role="status" className="mt-3 text-text">{t(locale, "waitlistDone", { host: practiceName })}</p>
      ) : (
        <form onSubmit={submit} className="mt-3 grid gap-3" noValidate>
          <div>
            <Label htmlFor="pwl-service">{practiceName}</Label>
            <select id="pwl-service" name="service" className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              {services.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="pwl-day">{t(locale, "day")}</Label>
            <Input id="pwl-day" name="day" type="date" min={today} defaultValue={today} required error={errors.day} />
          </div>
          <div>
            <Label htmlFor="pwl-name">{t(locale, "yourName")}</Label>
            <Input id="pwl-name" name="name" autoComplete="name" required maxLength={100} error={errors.name} />
          </div>
          <div>
            <Label htmlFor="pwl-email">{t(locale, "email")}</Label>
            <Input id="pwl-email" name="email" type="email" autoComplete="email" required error={errors.email} />
          </div>
          {(errors.form || errors.timezone) && <p role="alert" className="text-sm text-danger">{errors.form ?? errors.timezone}</p>}
          <Button type="submit" disabled={state === "sending"}>{t(locale, state === "sending" ? "joining" : "joinWaitlist")}</Button>
        </form>
      )}
    </details>
  );
}
