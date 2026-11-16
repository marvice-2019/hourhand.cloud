"use client";

import { useState } from "react";
import { Button } from "./ui/Button";
import { formatDate } from "@/lib/format";
import { t, type Locale } from "@/lib/i18n/guest";

type Kind = "access" | "erasure";

/** "Your data" on a guest's manage page: ask the host for a copy, or for deletion. Shows requests already open. */
export function DataRequest({ token, hostName, tz, open, locale = "en" }: { token: string; hostName: string; tz: string; open: { kind: Kind; dueAt: string }[]; locale?: Locale }) {
  const [sent, setSent] = useState(open);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [failed, setFailed] = useState(false);

  async function ask(kind: Kind) {
    setBusy(kind); setFailed(false);
    try {
      const res = await fetch(`/api/b/${encodeURIComponent(token)}/data-request`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }),
      });
      if (res.ok) {
        const body = (await res.json()) as { dueAt: string };
        setSent((s) => [...s.filter((x) => x.kind !== kind), { kind, dueAt: body.dueAt }]);
      } else setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(null);
  }

  const has = (k: Kind) => sent.find((s) => s.kind === k);
  return (
    <section aria-labelledby="data-heading" className="mt-8 max-w-md rounded-md bg-surface p-4">
      <h2 id="data-heading" className="font-semibold text-text">{t(locale, "yourData")}</h2>
      <p className="mt-1 text-sm text-text-muted">{t(locale, "yourDataIntro", { host: hostName })}</p>
      {sent.map((s) => (
        <p key={s.kind} className="mt-2 text-sm text-text" role="status">
          {t(locale, s.kind === "access" ? "copyRequested" : "deleteRequested", { host: hostName, date: formatDate(new Date(s.dueAt), tz, locale) })}
        </p>
      ))}
      <div className="mt-3 flex flex-wrap gap-2">
        {!has("access") && <Button variant="secondary" size="sm" loading={busy === "access"} onClick={() => void ask("access")}>{t(locale, "askCopy")}</Button>}
        {!has("erasure") && <Button variant="secondary" size="sm" loading={busy === "erasure"} onClick={() => void ask("erasure")}>{t(locale, "askDelete")}</Button>}
      </div>
      {!has("erasure") && <p className="mt-2 text-sm text-text-muted">{t(locale, "deleteHint", { host: hostName })}</p>}
      {failed && <p className="mt-2 text-sm text-danger" role="alert">{t(locale, "requestFailed", { host: hostName })}</p>}
    </section>
  );
}
