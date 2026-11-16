import { TZDate } from "@date-fns/tz";
import type pg from "pg";
import { dayKey } from "../format";

// Voice receptionist rows (db/migrations/0046_voice_receptionist.sql). Postgres only: in memory mode voice is off.

type Db = Pick<pg.Pool, "query">;

export interface VoiceSettings {
  hostId: string;
  enabled: boolean;
  keyVersion: number;
  monthlyMinuteCap: number;
  recordingEnabled: boolean;
  publicNote: string;
  agentId: string | null;
  phoneNumber: string | null;
  capWarnedMonth: string | null;
}

export interface VoiceCall {
  id: string;
  hostId: string;
  conversationId: string;
  callerPhone: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSecs: number;
  costPaise: number;
  outcome: CallOutcome;
  failedAttempts: number;
  bookingId: string | null;
}

export type CallOutcome = "in_progress" | "booked" | "payment_link" | "message" | "handoff" | "info" | "cap_reached" | "no_action";
export type MessageReason = "requested" | "handoff" | "out_of_scope" | "payment_issue" | "low_confidence" | "other";
export const MESSAGE_REASONS: readonly MessageReason[] = ["requested", "handoff", "out_of_scope", "payment_issue", "low_confidence", "other"];

const settingsRow = (r: Record<string, unknown>): VoiceSettings => ({
  hostId: r.host_id as string, enabled: r.enabled as boolean, keyVersion: r.key_version as number, monthlyMinuteCap: r.monthly_minute_cap as number,
  recordingEnabled: r.recording_enabled as boolean, publicNote: r.public_note as string, agentId: (r.agent_id as string) ?? null, phoneNumber: (r.phone_number as string) ?? null,
  capWarnedMonth: (r.cap_warned_month as string) ?? null,
});

const callRow = (r: Record<string, unknown>): VoiceCall => ({
  id: r.id as string, hostId: r.host_id as string, conversationId: r.conversation_id as string, callerPhone: (r.caller_phone as string) ?? null,
  startedAt: new Date(r.started_at as string), endedAt: r.ended_at ? new Date(r.ended_at as string) : null, durationSecs: r.duration_secs as number,
  costPaise: r.cost_paise as number, outcome: r.outcome as CallOutcome, failedAttempts: r.failed_attempts as number, bookingId: (r.booking_id as string) ?? null,
});

export async function getVoiceSettings(db: Db, hostId: string): Promise<VoiceSettings | null> {
  const { rows: [r] } = await db.query("select * from voice_settings where host_id = $1", [hostId]);
  return r ? settingsRow(r) : null;
}

export async function getVoiceSettingsByAgent(db: Db, agentId: string): Promise<VoiceSettings | null> {
  const { rows: [r] } = await db.query("select * from voice_settings where agent_id = $1", [agentId]);
  return r ? settingsRow(r) : null;
}

export type SettingsPatch = Partial<Pick<VoiceSettings, "enabled" | "monthlyMinuteCap" | "recordingEnabled" | "publicNote" | "agentId" | "phoneNumber">>;

/** Creates the host's row on first use; only the fields given change. */
export async function saveVoiceSettings(db: Db, hostId: string, patch: SettingsPatch): Promise<VoiceSettings> {
  const { rows: [r] } = await db.query(
    `insert into voice_settings (host_id, enabled, monthly_minute_cap, recording_enabled, agent_id, phone_number, public_note)
     values ($1, coalesce($2, false), coalesce($3, 100), coalesce($4, false), $5, $6, coalesce($9, ''))
     on conflict (host_id) do update set
       enabled = coalesce($2, voice_settings.enabled),
       monthly_minute_cap = coalesce($3, voice_settings.monthly_minute_cap),
       recording_enabled = coalesce($4, voice_settings.recording_enabled),
       agent_id = case when $7 then $5 else voice_settings.agent_id end,
       phone_number = case when $8 then $6 else voice_settings.phone_number end,
       public_note = coalesce($9, voice_settings.public_note),
       updated_at = now()
     returning *`,
    [hostId, patch.enabled ?? null, patch.monthlyMinuteCap ?? null, patch.recordingEnabled ?? null, patch.agentId ?? null, patch.phoneNumber ?? null,
      "agentId" in patch, "phoneNumber" in patch, patch.publicNote ?? null]);
  return settingsRow(r);
}

/** Revokes every key issued so far; returns the new version. */
export async function rotateKey(db: Db, hostId: string): Promise<number> {
  const { rows: [r] } = await db.query(
    `insert into voice_settings (host_id, key_version) values ($1, 2)
     on conflict (host_id) do update set key_version = voice_settings.key_version + 1, updated_at = now() returning key_version`, [hostId]);
  return r.key_version;
}

/** The calendar month (YYYY-MM) of `at` in the host's zone, and the instant it started. */
export function monthOf(at: Date, tz: string): { key: string; start: Date } {
  const key = dayKey(at, tz).slice(0, 7);
  const [y, m] = key.split("-").map(Number);
  return { key, start: new Date(new TZDate(y, m - 1, 1, 0, 0, 0, tz).getTime()) };
}

/** Seconds of calls this month (host's zone). In-progress calls count once the post-call webhook gives their length. */
export async function usedSecondsThisMonth(db: Db, hostId: string, tz: string, now: Date): Promise<number> {
  const { start } = monthOf(now, tz);
  const { rows: [r] } = await db.query("select coalesce(sum(duration_secs), 0)::int as s from voice_calls where host_id = $1 and started_at >= $2", [hostId, start]);
  return r.s;
}

/**
 * The call row for a conversation, opened on first sight. Null when the conversation id already belongs to another
 * host: one host's agent can never write into, or read, another host's call.
 */
export async function openCall(db: Db, hostId: string, conversationId: string, callerPhone: string | null, now: Date): Promise<VoiceCall | null> {
  const { rows: [r] } = await db.query(
    `insert into voice_calls (host_id, conversation_id, caller_phone, started_at) values ($1, $2, $3, $4)
     on conflict (conversation_id) do update set caller_phone = coalesce(voice_calls.caller_phone, excluded.caller_phone)
       where voice_calls.host_id = excluded.host_id
     returning *`, [hostId, conversationId, callerPhone, now]);
  return r ? callRow(r) : null;
}

/** Counts one failed attempt on the call; returns the new count. */
export async function addFailure(db: Db, callId: string): Promise<number> {
  const { rows: [r] } = await db.query("update voice_calls set failed_attempts = failed_attempts + 1 where id = $1 returning failed_attempts", [callId]);
  return r.failed_attempts;
}

/** Records what the call achieved. A stronger outcome is never overwritten by a weaker one (booked beats message beats info). */
export async function setOutcome(db: Db, callId: string, outcome: CallOutcome, bookingId: string | null = null): Promise<void> {
  await db.query(
    `update voice_calls set outcome = $2, booking_id = coalesce($3, booking_id)
     where id = $1 and array_position(array['in_progress','no_action','info','cap_reached','message','handoff','payment_link','booked'], outcome)
                     <= array_position(array['in_progress','no_action','info','cap_reached','message','handoff','payment_link','booked'], $2::text)`,
    [callId, outcome, bookingId]);
}

export async function addMessage(
  db: Db, m: { hostId: string; callId: string | null; callerName: string; callerPhone: string; body: string; reason: MessageReason },
): Promise<{ id: string; createdAt: Date }> {
  const { rows: [r] } = await db.query(
    `insert into voice_messages (host_id, call_id, caller_name, caller_phone, body, reason) values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
    [m.hostId, m.callId, m.callerName, m.callerPhone, m.body, m.reason]);
  return { id: r.id, createdAt: new Date(r.created_at) };
}

/**
 * Closes a call from the post-call webhook: its length and cost. Opens the row if no tool was ever called (a caller
 * who hung up after the greeting still uses minutes). Returns null when the conversation belongs to another host.
 */
export async function closeCall(
  db: Db, c: { hostId: string; conversationId: string; callerPhone: string | null; startedAt: Date; durationSecs: number; costPaise: number },
): Promise<VoiceCall | null> {
  const { rows: [r] } = await db.query(
    `insert into voice_calls (host_id, conversation_id, caller_phone, started_at, ended_at, duration_secs, cost_paise, outcome)
     values ($1, $2, $3, $4, $4::timestamptz + make_interval(secs => $5), $5, $6, 'no_action')
     on conflict (conversation_id) do update set
       ended_at = excluded.ended_at, duration_secs = excluded.duration_secs, cost_paise = excluded.cost_paise,
       started_at = least(voice_calls.started_at, excluded.started_at),
       caller_phone = coalesce(voice_calls.caller_phone, excluded.caller_phone),
       outcome = case when voice_calls.outcome = 'in_progress' then 'no_action' else voice_calls.outcome end
       where voice_calls.host_id = excluded.host_id
     returning *`, [c.hostId, c.conversationId, c.callerPhone, c.startedAt, c.durationSecs, c.costPaise]);
  return r ? callRow(r) : null;
}

/** Marks this month's 80% warning as sent. False when it already was (so only one email goes per month). */
export async function claimCapWarning(db: Db, hostId: string, month: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "update voice_settings set cap_warned_month = $2 where host_id = $1 and cap_warned_month is distinct from $2", [hostId, month]);
  return (rowCount ?? 0) > 0;
}

/** Undoes claimCapWarning when the email could not be sent, so the next call tries again. */
export async function releaseCapWarning(db: Db, hostId: string, month: string): Promise<void> {
  await db.query("update voice_settings set cap_warned_month = null where host_id = $1 and cap_warned_month = $2", [hostId, month]);
}

export async function listCalls(db: Db, hostId: string, limit = 50): Promise<VoiceCall[]> {
  const { rows } = await db.query("select * from voice_calls where host_id = $1 order by started_at desc limit $2", [hostId, limit]);
  return rows.map(callRow);
}

export interface VoiceMessage { id: string; callerName: string; callerPhone: string; body: string; reason: MessageReason; handledAt: Date | null; createdAt: Date }

export async function listMessages(db: Db, hostId: string, limit = 50): Promise<VoiceMessage[]> {
  const { rows } = await db.query("select * from voice_messages where host_id = $1 order by created_at desc limit $2", [hostId, limit]);
  return rows.map((r) => ({
    id: r.id, callerName: r.caller_name, callerPhone: r.caller_phone, body: r.body, reason: r.reason,
    handledAt: r.handled_at ? new Date(r.handled_at) : null, createdAt: new Date(r.created_at),
  }));
}

export async function markMessageHandled(db: Db, hostId: string, id: string, now: Date): Promise<void> {
  await db.query("update voice_messages set handled_at = $3 where id = $2 and host_id = $1 and handled_at is null", [hostId, id, now]);
}
