import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/Input";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { getOffer, listQuestions, MAX_ANSWER, type Question, type QuestionStatus } from "@/lib/questions/questions";
import { answerAction, declineAction, saveOfferAction } from "./actions";

export const dynamic = "force-dynamic";

const RESULTS: Record<string, [string, boolean]> = {
  saved: ["Saved.", true],
  answered: ["Answer sent. Your guest gets it by email.", true],
  declined: ["Declined. Your guest is told, and a paid question is refunded in full.", true],
  empty: ["Write an answer first.", false],
  too_long: [`Keep the answer to ${MAX_ANSWER} characters.`, false],
  not_open: ["That question was already answered or declined.", false],
  not_found: ["That question wasn't found.", false],
  invalid_price: ["Enter a price from ₹0 (free) to ₹1,00,000. A paid question costs at least ₹1.", false],
  invalid_responseDays: ["Pick 1 to 14 days.", false],
  invalid_intro: ["Keep the introduction to 500 characters.", false],
  demo: ["This demo can't save changes.", false],
};

const STATUS: Record<QuestionStatus, string> = {
  pending: "Waiting for payment", open: "Waiting for your answer", answered: "Answered", declined: "Declined",
  failed: "Not paid", refund_pending: "Declined, refund on its way", refunded: "Declined and refunded",
};

/** Ask a question (B19): the host's offer, and the questions guests sent, to answer or decline. */
export default async function QuestionsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const user = await requireHost();
  const { result } = await searchParams;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [offer, questions, plan] = pool
    ? await Promise.all([getOffer(pool, user.id), listQuestions(pool, user.id), hostPlan(pool, user.id)])
    : [{ active: false, priceMinor: 0, currency: "INR" as const, responseDays: 3, intro: null }, [] as Question[], "free" as const];
  const message = result ? RESULTS[result] : undefined;
  const tz = user.timezone;
  const open = questions.filter((q) => q.status === "open");
  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-xl text-text">Questions</h1>
      <p className="mt-1 text-text-muted">Let people ask you one written question, free or paid, and answer it here. They get your answer by email.</p>
      {message && <p role={message[1] ? "status" : "alert"} className={`mt-4 text-sm ${message[1] ? "text-success" : "text-danger"}`}>{message[0]}</p>}

      <Card className="mt-6">
        <h2 className="mb-3 font-semibold text-text">Your offer</h2>
        <form action={saveOfferAction} className="grid gap-4">
          <label className="flex items-center gap-2 text-text">
            <input type="checkbox" name="active" defaultChecked={offer.active} className={focusRing} /> Take questions
          </label>
          <div><Label htmlFor="price">Price per question (₹, 0 for free)</Label>
            <Input id="price" name="price" inputMode="decimal" defaultValue={String(offer.priceMinor / 100)} className="w-40" /></div>
          <div><Label htmlFor="responseDays">I answer within (days)</Label>
            <Input id="responseDays" name="responseDays" type="number" min={1} max={14} defaultValue={offer.responseDays} className="w-24" /></div>
          <div>
            <Label htmlFor="intro">What people can ask you (optional)</Label>
            <textarea id="intro" name="intro" maxLength={500} rows={3} defaultValue={offer.intro ?? ""}
              className={`mt-1 block w-full rounded-md border border-border-input bg-card px-3 py-2 text-base text-text ${focusRing}`} />
          </div>
          <div><Button type="submit" size="sm">Save</Button></div>
        </form>
        {offer.active && (
          <p className="mt-4 text-text">Your page: <Link href={`/${user.slug}/ask`} className={`text-accent underline ${focusRing}`}>hourhand.cloud/{user.slug}/ask</Link></p>
        )}
        {offer.priceMinor > 0 && plan === "free" && (
          <p className="mt-3 text-sm text-danger">Paid questions need the Solo or Duo plan and Razorpay connected under Integrations. Until then guests can&apos;t pay.</p>
        )}
      </Card>

      <h2 className="mt-8 font-semibold text-text">{open.length ? `${open.length} waiting for your answer` : "Questions"}</h2>
      {questions.length === 0 && <p className="mt-2 text-text-muted">No questions yet.</p>}
      <ul className="mt-3 grid gap-4">
        {questions.map((q) => (
          <li key={q.id}>
            <Card>
              <p className="text-sm text-text-muted">
                {q.guestName} · {q.guestEmail} · asked {formatDate(q.createdAt, tz)}{q.priceMinor > 0 ? ` · paid ${formatAmount(q.priceMinor, "INR")}` : " · free"}
              </p>
              <p className="mt-1 text-sm font-semibold text-text">{STATUS[q.status]}{q.status === "open" && q.dueAt ? `, by ${formatDate(q.dueAt, tz)}` : ""}</p>
              <p className="mt-2 whitespace-pre-line text-text">{q.question}</p>
              {q.answer && <p className="mt-3 whitespace-pre-line border-l-2 border-border pl-3 text-text">{q.answer}</p>}
              {q.status === "open" && (
                <>
                  <form action={answerAction} className="mt-3 grid gap-2">
                    <input type="hidden" name="id" value={q.id} />
                    <Label htmlFor={`answer-${q.id}`}>Your answer</Label>
                    <textarea id={`answer-${q.id}`} name="answer" required maxLength={MAX_ANSWER} rows={5}
                      className={`block w-full rounded-md border border-border-input bg-card px-3 py-2 text-base text-text ${focusRing}`} />
                    <div><Button type="submit" size="sm">Send answer</Button></div>
                  </form>
                  <form action={declineAction} className="mt-2">
                    <input type="hidden" name="id" value={q.id} />
                    <Button type="submit" size="sm" variant="secondary">{q.priceMinor > 0 ? "Decline and refund" : "Decline"}</Button>
                  </form>
                </>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
