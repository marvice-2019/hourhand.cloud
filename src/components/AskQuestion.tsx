"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";
import { payWithRazorpay, type CheckoutPayment } from "./razorpay-checkout";

const MAX = 2000;

/** Ask a host a question (B19): the question, then Razorpay Checkout when they charge, then the guest's own page. */
export function AskQuestion({ slug, hostName, price }: { slug: string; hostName: string; price: string | null }) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [length, setLength] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const guest = { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? "") };
    setBusy(true); setErrors({}); setMessage(null);
    try {
      const res = await fetch(`/api/questions/${encodeURIComponent(slug)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...guest, question: String(data.get("question") ?? ""), idempotencyKey }),
      });
      const body = await res.json();
      if (res.status === 400) { setErrors(body.fields ?? {}); return; }
      if (res.status === 409) { setMessage(`${hostName} isn't taking payments online right now. Contact them directly.`); return; }
      if (res.status === 429) { setMessage("Too many tries from here. Try again later."); return; }
      if (!res.ok) { setMessage("Something went wrong and nothing was charged. Try again."); return; }
      if (!body.payment) { router.push(`/q/${body.token}`); return; }
      const result = await payWithRazorpay(body.payment as CheckoutPayment, { name: hostName, description: "Your question", prefill: guest });
      if (!result) { setMessage("You haven't paid yet, so your question isn't sent. Press the button again when you're ready."); return; }
      // The server checks the payment with Razorpay; if this call is lost, it still confirms within a minute.
      await fetch("/api/questions/pay", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token, paymentId: result.razorpay_payment_id, signature: result.razorpay_signature }),
      }).catch(() => undefined);
      router.push(`/q/${body.token}`);
    } catch {
      setMessage("Something went wrong and nothing was charged. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 grid max-w-md gap-4">
      <div><Label htmlFor="name">Your name</Label><Input id="name" name="name" autoComplete="name" required maxLength={100} error={errors.name} /></div>
      <div><Label htmlFor="email">Email (your answer comes here)</Label><Input id="email" name="email" type="email" autoComplete="email" required error={errors.email} /></div>
      <div>
        <Label htmlFor="question">Your question</Label>
        <textarea id="question" name="question" required maxLength={MAX} rows={7} onChange={(e) => setLength(e.target.value.length)}
          aria-invalid={errors.question ? true : undefined} aria-describedby="question-count"
          className={`mt-1 block w-full rounded-md border bg-card px-3 py-2 text-base text-text ${errors.question ? "border-danger" : "border-border-input"} ${focusRing}`} />
        <p id="question-count" className="mt-1 text-sm text-text-muted">{length} / {MAX}</p>
        {errors.question && <p className="text-sm text-danger">{errors.question}</p>}
      </div>
      {message && <p className="text-danger" role="alert">{message}</p>}
      <Button type="submit" loading={busy}>{busy ? "Sending…" : price ? `Pay ${price} and send` : "Send question"}</Button>
      {price && <p className="text-sm text-text-muted">Pay by UPI, card or netbanking. If {hostName} can&apos;t answer, you get your money back in full.</p>}
    </form>
  );
}
