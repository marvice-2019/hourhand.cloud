"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { payWithRazorpay, type CheckoutPayment } from "./razorpay-checkout";

/** Buy a digital product (B20): name and email, then Razorpay Checkout when it's paid, then the buyer's own page. */
export function BuyProduct({ slug, product, hostName, title, price }: { slug: string; product: string; hostName: string; title: string; price: string | null }) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const buyer = { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? "") };
    setBusy(true); setErrors({}); setMessage(null);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(slug)}/${encodeURIComponent(product)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...buyer, idempotencyKey }),
      });
      const body = await res.json();
      if (res.status === 400) { setErrors(body.fields ?? {}); return; }
      if (res.status === 404) { setMessage("This product isn't on sale any more."); return; }
      if (res.status === 409) { setMessage(`${hostName} isn't taking payments online right now. Contact them directly.`); return; }
      if (res.status === 429) { setMessage("Too many tries from here. Try again later."); return; }
      if (!res.ok) { setMessage("Something went wrong and nothing was charged. Try again."); return; }
      if (!body.payment) { router.push(`/d/${body.token}`); return; }
      const result = await payWithRazorpay(body.payment as CheckoutPayment, { name: hostName, description: title, prefill: buyer });
      if (!result) { setMessage("You haven't paid yet. Press the button again when you're ready."); return; }
      // The server checks the payment with Razorpay; if this call is lost, it still confirms within a minute.
      await fetch("/api/products/pay", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token, paymentId: result.razorpay_payment_id, signature: result.razorpay_signature }),
      }).catch(() => undefined);
      router.push(`/d/${body.token}`);
    } catch {
      setMessage("Something went wrong and nothing was charged. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 grid max-w-md gap-4">
      <div><Label htmlFor="name">Your name</Label><Input id="name" name="name" autoComplete="name" required maxLength={100} error={errors.name} /></div>
      <div><Label htmlFor="email">Email (your link comes here)</Label><Input id="email" name="email" type="email" autoComplete="email" required error={errors.email} /></div>
      {message && <p className="text-danger" role="alert">{message}</p>}
      <Button type="submit" loading={busy}>{busy ? "Working…" : price ? `Pay ${price}` : "Get it free"}</Button>
      {price && <p className="text-sm text-text-muted">Pay by UPI, card or netbanking. You get your link straight away and by email.</p>}
    </form>
  );
}
