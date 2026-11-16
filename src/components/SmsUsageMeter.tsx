import type { SmsUsage } from "@/lib/sms/outbox";
import { makeHostI18n, type HostI18n } from "@/lib/i18n/host/format";

/** "Booking texts this month: 37 of 100", with a bar, and what happens at the limit. Server component. */
export function SmsUsageMeter({ usage, resets, i18n = makeHostI18n("en") }: { usage: SmsUsage; resets: string; i18n?: Pick<HostI18n, "t" | "tNodes"> }) {
  const { t, tNodes } = i18n;
  const { used, limit } = usage;
  if (limit === 0) {
    return <p className="mt-1 text-text-muted">{t("plan.smsFreeNote")}</p>;
  }
  const shown = Math.min(used, limit);
  const full = used >= limit;
  const near = !full && used >= limit * 0.8;
  return (
    <div className="mt-2">
      <p className="text-text">
        {tNodes("plan.smsUsed", { n: <span className="font-semibold">{shown}</span>, limit, resets })}
      </p>
      <div
        role="meter" aria-label={t("plan.smsMeterLabel")} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={shown}
        aria-valuetext={t("plan.smsMeterValue", { n: shown, limit })} className="mt-2 h-2 w-full max-w-sm overflow-hidden rounded-pill bg-surface"
      >
        <div className={`h-full rounded-pill ${full ? "bg-danger" : near ? "bg-warning" : "bg-accent"}`} style={{ width: `${(shown / limit) * 100}%` }} />
      </div>
      {full && <p role="status" className="mt-2 text-sm text-danger">{t("plan.smsFull", { resets })}</p>}
      {near && <p role="status" className="mt-2 text-sm text-text-muted">{t("plan.smsNear", { resets })}</p>}
    </div>
  );
}
