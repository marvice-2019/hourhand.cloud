import Link from "next/link";
import { PollForm } from "@/components/PollForms";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { acceptsVotes, listPolls } from "@/lib/polls/polls";

export const dynamic = "force-dynamic";

export default async function NewPollPage() {
  const user = await requireHost();
  const { t } = await getHostI18n();
  let freeLimitReached = false;
  if (authEnabled()) {
    const pool = getPool(process.env.DATABASE_URL as string);
    const now = new Date();
    const [plan, polls] = await Promise.all([hostPlan(pool, user.id), listPolls(pool, user.id)]);
    freeLimitReached = polls.filter((p) => acceptsVotes(p, now)).length >= LIMITS[plan].openPolls;
  }
  return (
    <div>
      <Link href="/dashboard/polls" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("polls.title")}</Link>
      <h1 className="font-display text-xl text-text">{t("polls.newPoll")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("polls.newIntro")}</p>
      <div className="mt-6"><PollForm timeZone={user.timezone} freeLimitReached={freeLimitReached} /></div>
    </div>
  );
}
