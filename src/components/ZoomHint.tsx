import Link from "next/link";
import type { ZoomSetup } from "@/lib/zoom/connection";

/** What choosing Zoom does, given the host's Zoom connection. */
export function ZoomHint({ setup, id }: { setup: ZoomSetup; id?: string }) {
  return (
    <p id={id} className="mt-1 text-sm text-text-muted">
      {setup === "connected" ? "Each booking gets its own Zoom meeting link from your Zoom account."
        : setup === "not_connected" ? <>Bookings won&apos;t get a Zoom link until you <Link href="/dashboard/integrations" className="font-semibold text-accent underline">connect Zoom</Link>.</>
        : "Zoom isn't set up on this server, so bookings won't get a Zoom link."}
    </p>
  );
}
