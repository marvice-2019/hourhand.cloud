import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { HandlerResult } from "../booking";
import type { DataStore } from "../data/types";
import type { Mailer } from "../mail/mailer";
import { recordingRule } from "./agent-config";
import { verifyElevenLabsSignature } from "./auth";
import { callCostPaise, type VoiceRates } from "./cost";
import { DISCLOSURE, RECORDING_NOTICE, SAY } from "./guardrails";
import { emailCapWarning } from "./notify";
import { claimCapWarning, closeCall, getVoiceSettingsByAgent, monthOf, releaseCapWarning, usedSecondsThisMonth } from "./store";
import { voiceEntitled } from "./tools";

// The two webhooks ElevenLabs calls for the whole workspace, told apart by agent id:
//   call start  (conversation initiation client data): before the agent speaks, gives it the host's name, the opening
//               line with the automated-assistant disclosure, and whether it may take the call at all (minute cap).
//   post-call   (post_call_transcription): the call's length; Hourhand stores length and cost, never the transcript.

export const CAP_WARNING_AT = 0.8;

export interface WebhookDeps {
  pool: pg.Pool;
  store: Pick<DataStore, "getUser">;
  planFor(hostId: string): Promise<string>;
  hasAddon?(hostId: string): Promise<boolean>;
  mailer: Mailer;
  rates: VoiceRates;
  baseUrl: string;
}

const constantEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * POST /api/voice/call-start. ElevenLabs sends the caller, the number called and the agent id, with our shared secret
 * in the Authorization header. Answers the agent's dynamic variables. A call over the cap or for a host whose voice is
 * off still gets an answer (`voice_allowed: no`): the agent says one line and ends the call.
 */
export async function handleCallStart(deps: WebhookDeps, secret: string, authHeader: string | null, input: unknown, now: Date): Promise<HandlerResult> {
  if (!authHeader || !constantEq(authHeader, `Bearer ${secret}`)) return { status: 401, body: { error: "unauthorized" } };
  const body = (input ?? {}) as Record<string, unknown>;
  const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
  const settings = agentId ? await getVoiceSettingsByAgent(deps.pool, agentId) : null;
  const host = settings ? await deps.store.getUser(settings.hostId) : null;
  if (!settings || !host) return { status: 404, body: { error: "not_found" } };
  const allowed = (await voiceEntitled(deps, settings, host.id))
    && (await usedSecondsThisMonth(deps.pool, host.id, host.timezone, now)) < settings.monthlyMinuteCap * 60;
  const rec = settings.recordingEnabled;
  return {
    status: 200,
    body: {
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        host_name: host.name,
        voice_allowed: allowed ? "yes" : "no",
        recording: rec ? "on" : "off",
        recording_rule: recordingRule(rec),
        opening_en: allowed ? `${DISCLOSURE.en(host.name)}${rec ? ` ${RECORDING_NOTICE.en}` : ""}` : SAY.capReached.en,
        opening_hi: allowed ? `${DISCLOSURE.hi(host.name)}${rec ? ` ${RECORDING_NOTICE.hi}` : ""}` : SAY.capReached.hi,
      },
    },
  };
}

/** POST /api/webhooks/elevenlabs. Signed with the webhook's secret (ElevenLabs-Signature); repeats are harmless. */
export async function handlePostCall(deps: WebhookDeps, signingSecret: string, rawBody: string, signature: string | null, now: Date): Promise<HandlerResult> {
  if (!verifyElevenLabsSignature(signingSecret, rawBody, signature, now)) return { status: 401, body: { error: "bad_signature" } };
  let payload: { type?: unknown; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  // Audio and failure events aren't used; acknowledge so ElevenLabs doesn't retry them.
  if (payload.type !== "post_call_transcription" || !payload.data) return { status: 200, body: { ignored: true } };
  const d = payload.data;
  const meta = (d.metadata ?? {}) as Record<string, unknown>;
  const agentId = typeof d.agent_id === "string" ? d.agent_id : "";
  const conversationId = typeof d.conversation_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(d.conversation_id) ? d.conversation_id : "";
  const settings = agentId ? await getVoiceSettingsByAgent(deps.pool, agentId) : null;
  // An agent Hourhand doesn't know (deleted host, another workspace agent): nothing to record.
  if (!settings || !conversationId) return { status: 200, body: { ignored: true } };
  const host = await deps.store.getUser(settings.hostId);
  if (!host) return { status: 200, body: { ignored: true } };

  const durationSecs = Math.max(0, Math.round(Number(meta.call_duration_secs) || 0));
  const startUnix = Number(meta.start_time_unix_secs);
  const startedAt = Number.isFinite(startUnix) && startUnix > 0 ? new Date(startUnix * 1000) : new Date(now.getTime() - durationSecs * 1000);
  const vars = ((d.conversation_initiation_client_data as Record<string, unknown> | undefined)?.dynamic_variables ?? {}) as Record<string, unknown>;
  const phoneCall = (meta.phone_call ?? {}) as Record<string, unknown>;
  const caller = [phoneCall.external_number, vars.system__caller_id].find((v): v is string => typeof v === "string" && /^\+?[0-9]{7,15}$/.test(v)) ?? null;

  const call = await closeCall(deps.pool, { hostId: host.id, conversationId, callerPhone: caller, startedAt, durationSecs, costPaise: callCostPaise(durationSecs, deps.rates) });
  if (!call) return { status: 200, body: { ignored: true } };
  await warnAtEightyPercent(deps, host.id, host.email, host.timezone, settings.monthlyMinuteCap, now);
  return { status: 200, body: { ok: true } };
}

/** Emails the host once a month when this month's minutes pass 80% of the cap. */
export async function warnAtEightyPercent(deps: Pick<WebhookDeps, "pool" | "mailer" | "baseUrl">, hostId: string, email: string, tz: string, capMinutes: number, now: Date): Promise<boolean> {
  if (capMinutes <= 0) return false;
  const used = await usedSecondsThisMonth(deps.pool, hostId, tz, now);
  if (used < capMinutes * 60 * CAP_WARNING_AT) return false;
  const { key } = monthOf(now, tz);
  if (!(await claimCapWarning(deps.pool, hostId, key))) return false;
  try {
    await emailCapWarning(deps.mailer, email, { hostId, month: key, usedMinutes: Math.ceil(used / 60), capMinutes, dashboardUrl: `${deps.baseUrl}/dashboard/voice` });
    return true;
  } catch (error) {
    await releaseCapWarning(deps.pool, hostId, key);
    console.error("[voice] cap warning email failed", (error as Error).message);
    return false;
  }
}
