import Link from "next/link";
import type { SyncStatus } from "@/lib/data";
import { focusRing } from "./ui/focus";
import type { HostI18n } from "@/lib/i18n/host/format";

const tone: Record<SyncStatus, string> = {
  ok: "bg-success-bg text-success",
  degraded: "bg-warning-bg text-warning",
  disconnected: "bg-danger-bg text-danger",
};

/** Calendar sync health as a dot plus words, so it never relies on colour alone. */
export function SyncLight({ status, minutesAgo, t }: { status: SyncStatus; minutesAgo?: number | null; t: HostI18n["t"] }) {
  const words =
    status === "ok"
      ? t("nav.syncOk", { n: minutesAgo ?? 0 })
      : status === "degraded"
        ? t("nav.syncSlow")
        : t("nav.syncDown");
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-2 rounded-pill px-3 py-1 text-xs ${tone[status]}`}>
        <span aria-hidden className="size-2 rounded-pill bg-current" />
        {words}
      </span>
      {status === "disconnected" && (
        <Link href="/dashboard/calendars" className={`inline-flex min-h-11 items-center rounded-sm px-1 text-sm font-semibold text-accent underline ${focusRing}`}>
          {t("nav.reconnect")}
        </Link>
      )}
    </div>
  );
}
