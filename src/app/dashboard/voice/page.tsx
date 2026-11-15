import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { VoiceSettingsForm } from "@/components/VoiceSettingsForm";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getAddon } from "@/lib/billing/addons";
import { billingFor } from "@/lib/billing/env";
import { addonLive, addonPriceId, addonPriceLine, formatMoney, VOICE_INCLUDED_MINUTES } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { mintToolKey, voiceToolsKey } from "@/lib/voice/auth";
import { getVoiceSettings, listCalls, listMessages, monthOf, usedSecondsThisMonth, type CallOutcome, type MessageReason } from "@/lib/voice/store";
import { VOICE_PLANS } from "@/lib/voice/tools";
import { buyVoiceAddon, cancelVoiceAddon, markHandled, rotateVoiceKey } from "./actions";

export const dynamic = "force-dynamic";

const OUTCOME: Record<CallOutcome, string> = {
  in_progress: "In progress", booked: "Booked", payment_link: "Pay link sent", message: "Message taken", handoff: "Handed to you",
  info: "Answered a question", cap_reached: "Over the limit", no_action: "No action",
};
const REASON: Record<MessageReason, string> = {
  requested: "Asked for you", handoff: "Couldn't finish", out_of_scope: "Not for the assistant", payment_issue: "Payment problem", low_confidence: "Unclear", other: "Message",
};
const ERRORS: Record<string, string> = {
  needs_plan: "The phone receptionist is for the Duo and Clinic plans.",
  already_subscribed: "You already have the phone receptionist add-on.",
  not_configured: "Payments for the phone receptionist aren't set up on this server yet.",
  no_subscription: "There's no add-on to cancel.",
  provider: "The payment provider didn't accept that. Try again in a minute; nothing was charged.",
};

const duration = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

export default async function VoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const live = authEnabled();
  if (!live) {
    return (
      <div>
        <h1 className="font-display text-xl text-text">Phone receptionist</h1>
        <p className="mt-6 text-text-muted">The demo data can&apos;t use the phone receptionist. Sign in with the database set up.</p>
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
  const monthCost = calls.filter((c) => c.startedAt >= start).reduce((n, c) => n + c.costPaise, 0);
  let toolKey: string | null = null;
  try {
    const k = voiceToolsKey();
    toolKey = k && settings ? mintToolKey(k, user.id, settings.keyVersion) : null;
  } catch {
    toolKey = null;
  }
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: user.timezone }).format(d);
  const open = messages.filter((m) => !m.handledAt);

  return (
    <div>
      <h1 className="font-display text-xl text-text">Phone receptionist</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        An automated assistant answers your number in English or Hindi. It tells callers it&apos;s automated, answers from your services and the note below,
        offers your free times and books them. Paid sessions get a link to pay, and the time is held 15 minutes. For anything else it takes a message for you.
        It never gives medical or therapy advice.
      </p>

      {params.saved && <p role="status" className="mt-4 text-success">Saved.</p>}
      {params.rotated && <p role="status" className="mt-4 max-w-xl text-success">New tool key made. The old one stopped working: paste the new one into your agent&apos;s secret now.</p>}
      {params.checkout === "done" && <p role="status" className="mt-4 max-w-xl text-success">Checkout finished. The add-on switches on as soon as Razorpay confirms the payment, usually within a minute.</p>}
      {params.checkout === "cancelled" && <p role="status" className="mt-4 text-text-muted">Checkout closed. Nothing was charged.</p>}
      {params.done === "cancelled" && <p role="status" className="mt-4 text-success">Add-on cancelled. It keeps answering until the end of the month you paid for.</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{(Object.hasOwn(ERRORS, params.error) && ERRORS[params.error]) || ERRORS.provider}</p>}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">Phone receptionist add-on</h2>
        <p className="mt-1 text-text">{addonPriceLine("voice")}, with {VOICE_INCLUDED_MINUTES} call minutes a month.</p>
        {addonOn && addon ? (
          <>
            <p className="mt-1 text-text-muted">
              {addon.cancelAtPeriodEnd ? `Cancelled. Answers calls until ${addon.currentPeriodEnd ? fmt(addon.currentPeriodEnd) : "the end of this month"}.` : `Active${addon.currentPeriodEnd ? `, renews ${fmt(addon.currentPeriodEnd)}` : ""}.`}
              {!eligible && " Your plan no longer includes it, so it is off until you're on Duo or Clinic again."}
            </p>
            {!addon.cancelAtPeriodEnd && <form action={cancelVoiceAddon} className="mt-4"><Button type="submit" variant="secondary" size="sm">Cancel add-on</Button></form>}
          </>
        ) : !eligible ? (
          <>
            <p className="mt-1 text-text-muted">{ERRORS.needs_plan}</p>
            <Link href="/dashboard/plan" className="mt-3 inline-block font-semibold text-accent underline">See plans</Link>
          </>
        ) : canBuy ? (
          <form action={buyVoiceAddon} className="mt-4"><Button type="submit">Add phone receptionist</Button></form>
        ) : (
          <p className="mt-1 text-text-muted">{ERRORS.not_configured}</p>
        )}
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">This month</h2>
        <p className="mt-1 text-text">
          {usedMin} of {cap} minutes used{cap > 0 && usedMin >= cap ? ": the assistant has stopped taking calls until next month." : "."}
        </p>
        <div className="mt-2 h-2 w-full max-w-md rounded-full bg-surface" aria-hidden>
          <div className={`h-2 rounded-full ${usedMin >= cap * 0.8 ? "bg-danger" : "bg-accent"}`} style={{ width: `${cap > 0 ? Math.min(100, (usedMin / cap) * 100) : 100}%` }} />
        </div>
        <p className="mt-2 text-sm text-text-muted">Calls: {calls.filter((c) => c.startedAt >= start).length}. Running cost to Hourhand: {formatMoney(monthCost, "INR")} (included in your add-on).</p>
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">Settings</h2>
        <div className="mt-4">
          <VoiceSettingsForm values={{
            enabled: settings?.enabled ?? false, recording: settings?.recordingEnabled ?? false, cap, publicNote: settings?.publicNote ?? "",
            agentId: settings?.agentId ?? "", phoneNumber: settings?.phoneNumber ?? "", maxCap: VOICE_INCLUDED_MINUTES,
          }} />
        </div>
      </Card>

      {settings && (
        <Card className="mt-6 max-w-2xl">
          <h2 className="font-semibold text-text">Tool key</h2>
          <p className="mt-1 text-sm text-text-muted">Your agent sends this with every request. It only works for your account. Keep it in the agent&apos;s secret named in the setup guide, and nowhere else.</p>
          {toolKey ? (
            <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-accent">Show key</summary><p className="mt-2 break-all font-mono text-sm text-text">Bearer {toolKey}</p></details>
          ) : (
            <p className="mt-3 text-sm text-text-muted">The voice tools aren&apos;t set up on this server yet (VOICE_TOOLS_KEY).</p>
          )}
          <form action={rotateVoiceKey} className="mt-3"><Button type="submit" variant="ghost" size="sm">Make a new key (the old one stops working)</Button></form>
        </Card>
      )}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">Messages {open.length > 0 && <span className="text-danger">({open.length} to call back)</span>}</h2>
        {messages.length === 0 ? <p className="mt-1 text-text-muted">No messages yet.</p> : (
          <ul className="mt-3 grid gap-3">
            {messages.map((m) => (
              <li key={m.id} className={m.handledAt ? "text-text-muted" : "text-text"}>
                <p><span className="font-semibold">{m.callerName}</span> · <a href={`tel:${m.callerPhone}`} className="underline">{m.callerPhone}</a> · {REASON[m.reason]} · {fmt(m.createdAt)}</p>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                {!m.handledAt && <form action={markHandled} className="mt-1"><input type="hidden" name="id" value={m.id} /><Button type="submit" variant="ghost" size="sm">Mark called back</Button></form>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">Calls</h2>
        {calls.length === 0 ? <p className="mt-1 text-text-muted">No calls yet.</p> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-text-muted"><tr><th className="py-1 pr-3 font-semibold">When</th><th className="py-1 pr-3 font-semibold">Caller</th><th className="py-1 pr-3 font-semibold">Length</th><th className="py-1 pr-3 font-semibold">Outcome</th><th className="py-1 font-semibold">Cost</th></tr></thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="py-1 pr-3">{fmt(c.startedAt)}</td>
                    <td className="py-1 pr-3">{c.callerPhone ?? "Hidden"}</td>
                    <td className="py-1 pr-3">{duration(c.durationSecs)}</td>
                    <td className="py-1 pr-3">{c.bookingId ? <Link href={`/dashboard/bookings/${c.bookingId}`} className="underline">{OUTCOME[c.outcome]}</Link> : OUTCOME[c.outcome]}</td>
                    <td className="py-1">{formatMoney(c.costPaise, "INR")}</td>
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
