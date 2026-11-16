import type { SourceInput } from "@/lib/analytics/source";

/**
 * Tells this site's own /api/events that a guest picked a time. First-party only: no cookie, no identifier, and
 * nothing at all when the browser says Do Not Track or Global Privacy Control. Fire and forget.
 */
export function sendSlotClick(slug: string, event: string, src: SourceInput): void {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.globalPrivacyControl || nav.doNotTrack === "1") return;
    const body = JSON.stringify({ kind: "slot_click", slug, event, src });
    if (typeof nav.sendBeacon === "function" && nav.sendBeacon("/api/events", new Blob([body], { type: "text/plain" }))) return;
    void fetch("/api/events", { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
  } catch {
    // Analytics never gets in the guest's way.
  }
}
