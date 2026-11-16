"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { subscribeWithRazorpay } from "./razorpay-checkout";

/** Join a membership: details, then Razorpay Checkout to set up the monthly mandate and pay month one, then the member's page. */
export function MembershipJoin({ planId, price, hostName, planName }: { planId: string; price: string; hostName: string; planName: string }) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const who = { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? ""), phone: String(data.get("phone") ?? "") };
    setBusy(true); setErrors({}); setMessage(null);
    try {
      const res = await fetch(`/api/memberships/${encodeURIComponent(planId)}/join`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...who, idempotencyKey }),
      });
      const body = await res.json();
      if (res.status === 400) { setErrors(body.fields ?? {}); return; }
      if (res.status === 404) { setMessage("This membership isn't on offer any more."); return; }
      if (res.status === 409) { setMessage(`${hostName} isn't taking memberships online right now. Contact them directly.`); return; }
      if (res.status === 429) { setMessage("Too many tries from here in the last hour. Try again later."); return; }
      if (!res.ok) { setMessage("Something went wrong and nothing was charged. Try again."); return; }
      if (!body.checkout) { router.push(`/member/${body.token}`); return; } // already set up
      const done = await subscribeWithRazorpay({ keyId: body.checkout.publicKey, subscriptionId: body.checkout.subscriptionId }, {
        name: hostName, description: `${planName}, monthly`, prefill: { name: who.name, email: who.email, ...(who.phone ? { contact: who.phone } : {}) },
      });
      if (!done) { setMessage("You haven't finished setting up the payment. Press the button again when you're ready."); return; }
      router.push(`/member/${body.token}`);
    } catch {
      setMessage("Razorpay didn't open, and nothing was charged. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 grid max-w-md gap-4">
      <div><Label htmlFor="name">Your name</Label><Input id="name" name="name" autoComplete="name" required maxLength={100} error={errors.name} /></div>
      <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" required error={errors.email} /></div>
      <div><Label htmlFor="phone">Phone (optional)</Label><Input id="phone" name="phone" type="tel" autoComplete="tel" error={errors.phone} /></div>
      {message && <p className="text-danger" role="alert">{message}</p>}
      <Button type="submit" loading={busy}>{busy ? "Opening payment…" : `Join for ${price} a month`}</Button>
      <p className="text-sm text-text-muted">
        You approve a monthly mandate by card or UPI Autopay and pay the first month now. It renews each month until you cancel, which you can do any time from your member link.
      </p>
    </form>
  );
}
