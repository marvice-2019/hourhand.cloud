import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { questionByToken, type QuestionStatus } from "@/lib/questions/questions";

export const dynamic = "force-dynamic";

const STATUS: Record<QuestionStatus, string> = {
  pending: "Waiting for your payment. If you paid, this page updates within a minute or two.",
  open: "Sent. You'll get the answer by email.",
  answered: "Answered.",
  declined: "Declined: they can't answer this one.",
  failed: "Not sent: the payment didn't go through, and nothing was charged.",
  refund_pending: "Declined: your payment is being refunded in full.",
  refunded: "Declined: your payment was refunded in full. Banks usually take 5 to 7 working days.",
};

/** The guest's private page for their question (B19), from the link in their emails. */
export default async function QuestionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const q = authEnabled() ? await questionByToken(getPool(process.env.DATABASE_URL as string), token) : null;
  if (!q) notFound();
  const tz = "Asia/Kolkata";
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{q.hostName}</p>
      <h1 className="font-display text-xl text-text">Your question</h1>
      <p role="status" className="mt-2 text-text">{STATUS[q.status]}</p>
      {q.status === "open" && q.dueAt && <p className="mt-1 text-text-muted">{q.hostName} aims to answer by {formatDate(q.dueAt, tz)}.</p>}
      <Card className="mt-4">
        <p className="text-sm text-text-muted">Asked {formatDate(q.createdAt, tz)}{q.priceMinor > 0 ? ` · ${formatAmount(q.priceMinor, "INR")}` : ""}</p>
        <p className="mt-2 whitespace-pre-line text-text">{q.question}</p>
      </Card>
      {q.answer && (
        <Card className="mt-4">
          <h2 className="font-semibold text-text">{q.hostName}&apos;s answer</h2>
          <p className="mt-2 whitespace-pre-line text-text">{q.answer}</p>
          {q.answeredAt && <p className="mt-2 text-sm text-text-muted">Answered {formatDate(q.answeredAt, tz)}</p>}
        </Card>
      )}
      <p className="mt-6 text-sm text-text-muted">Keep this link private: anyone with it can read your question and the answer.</p>
    </main>
  );
}
