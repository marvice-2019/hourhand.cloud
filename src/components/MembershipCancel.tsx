"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";

/** The member stops renewing from their own link. Two steps, so a stray tap doesn't cancel. */
export function MembershipCancel({ token, until }: { token: string; until: string | null }) {
  const router = useRouter();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function cancel() {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/memberships/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      if (!res.ok) { setMessage("Couldn't cancel just now. Nothing changed; try again in a minute."); return; }
      router.refresh();
    } catch {
      setMessage("Couldn't reach Hourhand. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!sure) return <Button variant="ghost" onClick={() => setSure(true)}>Cancel membership</Button>;
  return (
    <div className="grid max-w-md gap-3" role="group" aria-label="Confirm cancelling">
      <p className="text-text">{until ? `You won't be charged again. Sessions you have left stay bookable for times before ${until}.` : "You won't be charged."}</p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={cancel} loading={busy}>Yes, cancel</Button>
        <Button variant="ghost" onClick={() => setSure(false)}>Keep it</Button>
      </div>
      {message && <p className="text-danger" role="alert">{message}</p>}
    </div>
  );
}
