import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/Input";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { getOffer, listQuestions, MAX_ANSWER, type Question, type QuestionStatus } from "@/lib/questions/questions";
import { answerAction, declineAction, saveOfferAction } from "./actions";

export const dynamic = "force-dynamic";

const RESULTS: Record<string, [HostKey, boolean]> = {
  saved: ["questions.rSaved", true], answered: ["questions.rAnswered", true], declined: ["questions.rDeclined", true],
  empty: ["questions.rEmpty", false], too_long: ["questions.rTooLong", false], not_open: ["questions.rNotOpen", false],
  not_found: ["questions.rNotFound", false], invalid_price: ["questions.rPrice", false], invalid_responseDays: ["questions.rResponseDays", false],
  invalid_intro: ["questions.rIntro", false], demo: ["questions.rDemo", false],
};

const STATUS: Record<QuestionStatus, HostKey> = {
  pending: "questions.sPending", open: "questions.sOpen", answered: "questions.sAnswered", declined: "questions.sDeclined",
  failed: "questions.sFailed", refund_pending: "questions.sRefundPending", refunded: "questions.sRefunded",
};
/** A question closed for missing its due date (B21) says so, whichever way it was closed. */
const EXPIRED: Partial<Record<QuestionStatus, HostKey>> = {
  declined: "questions.sExpired", refund_pending: "questions.sExpiredRefundPending", refunded: "questions.sExpiredRefunded",
};
const statusKey = (q: Question): HostKey => (q.expired && EXPIRED[q.status]) || STATUS[q.status];

/** Ask a question (B19): the host's offer, and the questions guests sent, to answer or decline. */
export default async function QuestionsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const user = await requireHost();
  const { result } = await searchParams;
  const { t, date, money } = await getHostI18n();
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [offer, questions, plan] = pool
    ? await Promise.all([getOffer(pool, user.id), listQuestions(pool, user.id), hostPlan(pool, user.id)])
    : [{ active: false, priceMinor: 0, currency: "INR" as const, responseDays: 3, intro: null }, [] as Question[], "free" as const];
  const message = result ? RESULTS[result] : undefined;
  const tz = user.timezone;
  const open = questions.filter((q) => q.status === "open");
  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-xl text-text">{t("questions.title")}</h1>
      <p className="mt-1 text-text-muted">{t("questions.intro")}</p>
      {message && <p role={message[1] ? "status" : "alert"} className={`mt-4 text-sm ${message[1] ? "text-success" : "text-danger"}`}>{t(message[0], { n: MAX_ANSWER })}</p>}

      <Card className="mt-6">
        <h2 className="mb-3 font-semibold text-text">{t("questions.offer")}</h2>
        <form action={saveOfferAction} className="grid gap-4">
          <label className="flex items-center gap-2 text-text">
            <input type="checkbox" name="active" defaultChecked={offer.active} className={focusRing} /> {t("questions.active")}
          </label>
          <div><Label htmlFor="price">{t("questions.price")}</Label>
            <Input id="price" name="price" inputMode="decimal" defaultValue={String(offer.priceMinor / 100)} className="w-40" /></div>
          <div><Label htmlFor="responseDays">{t("questions.responseDays")}</Label>
            <Input id="responseDays" name="responseDays" type="number" min={1} max={14} defaultValue={offer.responseDays} className="w-24" aria-describedby="responseDays-help" />
            <p id="responseDays-help" className="mt-1 text-sm text-text-muted">{t("questions.deadlineHelp")}</p></div>
          <div>
            <Label htmlFor="intro">{t("questions.introLabel")}</Label>
            <textarea id="intro" name="intro" maxLength={500} rows={3} defaultValue={offer.intro ?? ""}
              className={`mt-1 block w-full rounded-md border border-border-input bg-card px-3 py-2 text-base text-text ${focusRing}`} />
          </div>
          <div><Button type="submit" size="sm">{t("questions.save")}</Button></div>
        </form>
        {offer.active && (
          <p className="mt-4 text-text">{t("questions.yourPage")} <Link href={`/${user.slug}/ask`} className={`text-accent underline ${focusRing}`}>{t("questions.pageUrl", { slug: user.slug })}</Link></p>
        )}
        {offer.priceMinor > 0 && plan === "free" && (
          <p className="mt-3 text-sm text-danger">{t("questions.needsPlan")}</p>
        )}
      </Card>

      <h2 className="mt-8 font-semibold text-text">{open.length ? t("questions.waiting", { n: open.length }) : t("questions.list")}</h2>
      {questions.length === 0 && <p className="mt-2 text-text-muted">{t("questions.none")}</p>}
      <ul className="mt-3 grid gap-4">
        {questions.map((q) => (
          <li key={q.id}>
            <Card>
              <p className="text-sm text-text-muted">
                {t("questions.meta", { name: q.guestName, email: q.guestEmail, date: date(q.createdAt, tz) })} · {q.priceMinor > 0 ? t("questions.paid", { amount: money(q.priceMinor, "INR") }) : t("questions.free")}
              </p>
              <p className="mt-1 text-sm font-semibold text-text">{q.status === "open" && q.dueAt ? t("questions.by", { status: t(STATUS[q.status]), date: date(q.dueAt, tz) }) : t(statusKey(q))}</p>
              <p className="mt-2 whitespace-pre-line text-text">{q.question}</p>
              {q.answer && <p className="mt-3 whitespace-pre-line border-l-2 border-border pl-3 text-text">{q.answer}</p>}
              {q.status === "open" && (
                <>
                  <form action={answerAction} className="mt-3 grid gap-2">
                    <input type="hidden" name="id" value={q.id} />
                    <Label htmlFor={`answer-${q.id}`}>{t("questions.answerLabel")}</Label>
                    <textarea id={`answer-${q.id}`} name="answer" required maxLength={MAX_ANSWER} rows={5}
                      className={`block w-full rounded-md border border-border-input bg-card px-3 py-2 text-base text-text ${focusRing}`} />
                    <div><Button type="submit" size="sm">{t("questions.send")}</Button></div>
                  </form>
                  <form action={declineAction} className="mt-2">
                    <input type="hidden" name="id" value={q.id} />
                    <Button type="submit" size="sm" variant="secondary">{q.priceMinor > 0 ? t("questions.declineRefund") : t("questions.decline")}</Button>
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
