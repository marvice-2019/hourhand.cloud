import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { VoiceSettingsForm } from "@/components/VoiceSettingsForm";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getAddon } from "@/lib/billing/addons";
import { billingFor } from "@/lib/billing/env";
import { ADDON_PRICES, addonLive, addonPriceId, GST_RATE, VOICE_INCLUDED_MINUTES } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { mintToolKey, voiceToolsKey } from "@/lib/voice/auth";
import { getVoiceSettings, listCalls, listMessages, monthOf, usedSecondsThisMonth, type CallOutcome, type MessageReason } from "@/lib/voice/store";
import { VOICE_PLANS } from "@/lib/voice/tools";
import { buyVoiceAddon, cancelVoiceAddon, markHandled, rotateVoiceKey } from "./actions";

export const dynamic = "force-dynamic";

const OUTCOME: Record<CallOutcome, HostKey> = {
  in_progress: "voice.outcomeInProgress", booked: "voice.outcomeBooked", payment_link: "voice.outcomePaymentLink", message: "voice.outcomeMessage",
  handoff: "voice.outcomeHandoff", info: "voice.outcomeInfo", cap_reached: "voice.outcomeCapReached", no_action: "voice.outcomeNoAction",
};
const REASON: Record<MessageReason, HostKey> = {
  requested: "voice.reasonRequested", handoff: "voice.reasonHandoff", out_of_scope: "voice.reasonOutOfScope",
  payment_issue: "voice.reasonPaymentIssue", low_confidence: "voice.reasonLowConfidence", other: "voice.reasonOther",
};
const ERRORS: Record<string, HostKey> = {
  needs_plan: "voice.errorNeedsPlan",
  already_subscribed: "voice.errorAlreadySubscribed",
  not_configured: "voice.errorNotConfigured",
  no_subscription: "voice.errorNoSubscription",
  provider: "voice.errorProvider",
};

/** m:ss, for a call's length. */
const duration = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

export default async function VoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const { t, inr, number, mediumDateTime } = await getHostI18n();
  if (!authEnabled()) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">{t("voice.title")}</h1>
        <p className="mt-6 text-text-muted">{t("voice.demo")}</p>
      </div>
    );
  }
  const pool = getPool(process.env.DATABASE_URL as string);
  const now = new Date();
  const [plan, addon, settings, usedSecs, calls, messages] = await Promise.all([
    hostPlan(pool, user.id), getAddon(pool, user.id, "voice"), getVoiceSettings(pool, user.id), usedSecondsThisMonth(pool, user.id, user.timezone, now),
    listCalls(pool, user.id, 50), listMessages(pool, user.id, 50),
  ]);
  const eligible = VOICE_PLANS.includes(plan);
  const addonOn = addonLive(addon);
  const canBuy = billingFor("razorpay") !== null && addonPriceId("voice") !== null;
  const cap = settings?.monthlyMinuteCap ?? VOICE_INCLUDED_MINUTES;
  const usedMin = Math.ceil(usedSecs / 60);
  const { start } = monthOf(now, user.timezone);
  const thisMonth = calls.filter((c) => c.startedAt >= start);
  const monthCost = thisMonth.reduce((n, c) => n + c.costPaise, 0);
  let toolKey: string | null = null;
  try {
    const k = voiceToolsKey();
    toolKey = k && settings ? mintToolKey(k, user.id, settings.keyVersion) : null;
  } catch {
    toolKey = null;
  }
  const when = (d: Date) => mediumDateTime(d, user.timezone);
  const open = messages.filter((m) => !m.handledAt);
  const addonBase = ADDON_PRICES.voice.month.INR;

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("voice.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("voice.intro")}</p>

      {params.saved && <p role="status" className="mt-4 text-success">{t("voice.saved")}</p>}
      {params.rotated && <p role="status" className="mt-4 max-w-xl text-success">{t("voice.rotated")}</p>}
      {params.checkout === "done" && <p role="status" className="mt-4 max-w-xl text-success">{t("voice.checkoutDone")}</p>}
      {params.checkout === "cancelled" && <p role="status" className="mt-4 text-text-muted">{t("voice.checkoutCancelled")}</p>}
      {params.done === "cancelled" && <p role="status" className="mt-4 text-success">{t("voice.addonCancelledNotice")}</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(ERRORS, params.error) && ERRORS[params.error]) || ERRORS.provider)}</p>}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("voice.addonTitle")}</h2>
        <p className="mt-1 text-text">{t("voice.addonPrice", { base: inr(addonBase), total: inr(Math.round(addonBase * (1 + GST_RATE))), minutes: number(VOICE_INCLUDED_MINUTES) })}</p>
        {addonOn && addon ? (
          <>
            <p className="mt-1 text-text-muted">
              {addon.cancelAtPeriodEnd
                ? (addon.currentPeriodEnd ? t("voice.addonCancelledUntil", { when: when(addon.currentPeriodEnd) }) : t("voice.addonCancelledMonthEnd"))
                : (addon.currentPeriodEnd ? t("voice.addonActiveRenews", { when: when(addon.currentPeriodEnd) }) : t("voice.addonActive"))}
              {!eligible && <> {t("voice.addonPlanLapsed")}</>}
            </p>
            {!addon.cancelAtPeriodEnd && <form action={cancelVoiceAddon} className="mt-4"><Button type="submit" variant="secondary" size="sm">{t("voice.addonCancel")}</Button></form>}
          </>
        ) : !eligible ? (
          <>
            <p className="mt-1 text-text-muted">{t("voice.errorNeedsPlan")}</p>
            <Link href="/dashboard/plan" className="mt-3 inline-block font-semibold text-accent underline">{t("voice.seePlans")}</Link>
          </>
        ) : canBuy ? (
          <form action={buyVoiceAddon} className="mt-4"><Button type="submit">{t("voice.addonBuy")}</Button></form>
        ) : (
          <p className="mt-1 text-text-muted">{t("voice.errorNotConfigured")}</p>
        )}
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("voice.monthTitle")}</h2>
        <p className="mt-1 text-text">
          {t(cap > 0 && usedMin >= cap ? "voice.minutesStopped" : "voice.minutesUsed", { used: number(usedMin), cap: number(cap) })}
        </p>
        <div className="mt-2 h-2 w-full max-w-md rounded-full bg-surface" aria-hidden>
          <div className={`h-2 rounded-full ${usedMin >= cap * 0.8 ? "bg-danger" : "bg-accent"}`} style={{ width: `${cap > 0 ? Math.min(100, (usedMin / cap) * 100) : 100}%` }} />
        </div>
        <p className="mt-2 text-sm text-text-muted">{t("voice.monthCalls", { calls: number(thisMonth.length), cost: inr(monthCost) })}</p>
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("voice.settingsTitle")}</h2>
        <div className="mt-4">
          <VoiceSettingsForm values={{
            enabled: settings?.enabled ?? false, recording: settings?.recordingEnabled ?? false, cap, publicNote: settings?.publicNote ?? "",
            agentId: settings?.agentId ?? "", phoneNumber: settings?.phoneNumber ?? "", maxCap: VOICE_INCLUDED_MINUTES,
          }} />
        </div>
      </Card>

      {settings && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">{t("voice.keyTitle")}</h2>
          <p className="mt-1 text-sm text-text-muted">{t("voice.keyIntro")}</p>
          {toolKey ? (
            // i18n-ignore: "Bearer" is part of the header value pasted into ElevenLabs
            <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-accent">{t("voice.keyShow")}</summary><p className="mt-2 break-all font-mono text-sm text-text">{`Bearer ${toolKey}`}</p></details>
          ) : (
            <p className="mt-3 text-sm text-text-muted">{t("voice.keyNotSetUp")}</p>
          )}
          <form action={rotateVoiceKey} className="mt-3"><Button type="submit" variant="ghost" size="sm">{t("voice.keyRotate")}</Button></form>
        </Card>
      )}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("voice.messagesTitle")} {open.length > 0 && <span className="text-danger">{t("voice.messagesToCall", { count: number(open.length) })}</span>}</h2>
        {messages.length === 0 ? <p className="mt-1 text-text-muted">{t("voice.noMessages")}</p> : (
          <ul className="mt-3 grid gap-3">
            {messages.map((m) => (
              <li key={m.id} className={m.handledAt ? "text-text-muted" : "text-text"}>
                <p><span className="font-semibold">{m.callerName}</span> · <a href={`tel:${m.callerPhone}`} className="underline">{m.callerPhone}</a> · {t(REASON[m.reason])} · {when(m.createdAt)}</p>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                {!m.handledAt && <form action={markHandled} className="mt-1"><input type="hidden" name="id" value={m.id} /><Button type="submit" variant="ghost" size="sm">{t("voice.markHandled")}</Button></form>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("voice.callsTitle")}</h2>
        {calls.length === 0 ? <p className="mt-1 text-text-muted">{t("voice.noCalls")}</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-text-muted">
                <tr>
                  <th className="py-1 pr-3 font-semibold">{t("voice.colWhen")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("voice.colCaller")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("voice.colLength")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("voice.colOutcome")}</th>
                  <th className="py-1 font-semibold">{t("voice.colCost")}</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="py-1 pr-3">{when(c.startedAt)}</td>
                    <td className="py-1 pr-3">{c.callerPhone ?? t("voice.callerHidden")}</td>
                    <td className="py-1 pr-3">{duration(c.durationSecs)}</td>
                    <td className="py-1 pr-3">{c.bookingId ? <Link href={`/dashboard/bookings/${c.bookingId}`} className="underline">{t(OUTCOME[c.outcome])}</Link> : t(OUTCOME[c.outcome])}</td>
                    <td className="py-1">{inr(c.costPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
