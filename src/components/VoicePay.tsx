"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";
import { payWithRazorpay, type CheckoutPayment } from "./razorpay-checkout";

/** Pays for a time the phone assistant held: Razorpay Checkout, then the booking's own page. */
export function VoicePay({ token, payment, label, hostName, description, guest }: {
  token: string; payment: CheckoutPayment; label: string; hostName: string; description: string; guest: { name: string; email: string; phone: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pay() {
    setBusy(true); setMessage(null);
    try {
      const result = await payWithRazorpay(payment, { name: hostName, description, prefill: { name: guest.name, email: guest.email, contact: guest.phone } });
      if (!result) { setBusy(false); return; }
      const res = await fetch("/api/bookings/pay", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ manageToken: token, paymentId: result.razorpay_payment_id, signature: result.razorpay_signature }),
      });
      if (res.status === 400 && (await res.json().catch(() => ({}))).error === "not_paid") {
        setMessage("The payment didn't go through. Nothing was charged; try again."); setBusy(false);
        return;
      }
    } catch {
      // The reconciler confirms a real payment within a minute even if this call never arrives.
    }
    router.push(`/b/${token}`);
  }

  return (
    <div className="mt-4">
      <Button onClick={pay} disabled={busy}>{busy ? "Opening payment…" : label}</Button>
      {message && <p className="mt-2 text-danger" role="alert">{message}</p>}
    </div>
  );
}
