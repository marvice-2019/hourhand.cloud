"use client";

import { useState } from "react";
import { Button } from "./ui/Button";
import { t, type Locale } from "@/lib/i18n/guest";

/** The guest's switch for this booking's texts, on the manage page. */
export function SmsToggle({ token, phone, on: initial, locale = "en" }: { token: string; phone: string; on: boolean; locale?: Locale }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function flip() {
    setBusy(true); setFailed(false);
    try {
      const res = await fetch(`/api/b/${encodeURIComponent(token)}/sms`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: !on }),
      });
      if (res.ok) setOn(!on);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <section aria-labelledby="texts-heading" className="mt-6 max-w-md rounded-md bg-surface p-4">
      <h2 id="texts-heading" className="font-semibold text-text">{t(locale, "textsHeading")}</h2>
      <p className="mt-1 text-text" role="status">{on ? t(locale, "textsOn", { phone }) : t(locale, "textsOff")}</p>
      <Button className="mt-3" variant="secondary" size="sm" loading={busy} onClick={() => void flip()}>{t(locale, on ? "textsTurnOff" : "textsTurnOn")}</Button>
      {failed && <p className="mt-2 text-sm text-danger" role="alert">{t(locale, "textsFailed")}</p>}
    </section>
  );
}
