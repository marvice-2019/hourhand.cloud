"use client";

import Link from "next/link";
import type { ZoomSetup } from "@/lib/zoom/connection";
import { useHostI18n } from "./HostI18nProvider";

/** What choosing Zoom does, given the host's Zoom connection. */
export function ZoomHint({ setup, id }: { setup: ZoomSetup; id?: string }) {
  const { t, tNodes } = useHostI18n();
  return (
    <p id={id} className="mt-1 text-sm text-text-muted">
      {setup === "connected" ? t("eventTypes.zoomConnected")
        : setup === "not_connected" ? <>{tNodes("eventTypes.zoomNotConnected", { link: <Link key="link" href="/dashboard/integrations" className="font-semibold text-accent underline">{t("eventTypes.zoomConnectLink")}</Link> })}</>
        : t("eventTypes.zoomNotConfigured")}
    </p>
  );
}
