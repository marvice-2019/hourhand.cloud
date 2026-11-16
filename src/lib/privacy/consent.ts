import type pg from "pg";
import type { CustomQuestion, InviteeAnswer } from "../data/types";

// The consent log. When a guest books, Hourhand records what they agreed to (and what they left unticked), the words
// they saw, the privacy notice version and where they booked. Hosts are the data fiduciaries for this data; the log is
// their record that notice was given and consent obtained (DPDP Act 2023, s.5, s.6(1) and s.6(10)). Working draft:
// review the purposes and wording with a lawyer.

/** The version of the privacy notice at /privacy that guests are pointed to. Bump it whenever that page's guest text changes. */
export const PRIVACY_NOTICE_VERSION = "2026-11-15";

export type ConsentPurpose = "booking" | "whatsapp_updates" | "sms_updates" | "host_question";
export type ConsentChannel = "booking_page" | "single_use_link" | "package_link";

/** One line of the log as the booking supplies it; the store adds the booking, client and time. */
export interface ConsentInput {
  purpose: ConsentPurpose;
  granted: boolean;
  /** What the guest was shown, in their language. */
  statement: string;
  noticeVersion: string;
  channel: ConsentChannel;
}

export interface ConsentRecord extends ConsentInput {
  id: string;
  bookingId: string;
  locale: string;
  recordedAt: Date;
}

export const PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  booking: "Booking details",
  whatsapp_updates: "WhatsApp updates",
  sms_updates: "SMS updates",
  host_question: "Your consent question",
};

export const CHANNEL_LABELS: Record<ConsentChannel, string> = {
  booking_page: "Booking page",
  single_use_link: "Single-use link",
  package_link: "Package link",
};

/** The booking purpose: the guest's details go to the host to arrange and run this booking (DPDP s.7(a) legitimate use). */
export function bookingStatement(hostName: string): string {
  return `My name, email, phone (if given) and answers go to ${hostName || "the host"} to arrange and run this booking, as described in the Hourhand privacy notice.`;
}

/**
 * The log lines for one booking: the booking itself, WhatsApp updates when the guest ticked them for a phone, and each
 * of the host's consent questions, ticked or not. Pure: the caller passes what the guest saw and answered.
 */
export function consentFor(opts: {
  hostName: string;
  channel: ConsentChannel;
  whatsappOptIn: boolean;
  whatsappStatement: string;
  /** SMS updates ticked for an Indian mobile number. Optional so callers from before SMS existed still build. */
  smsOptIn?: boolean;
  smsStatement?: string;
  questions: Pick<CustomQuestion, "id" | "label" | "kind">[];
  answers: InviteeAnswer[];
  noticeVersion?: string;
}): ConsentInput[] {
  const noticeVersion = opts.noticeVersion ?? PRIVACY_NOTICE_VERSION;
  const base = { noticeVersion, channel: opts.channel };
  const lines: ConsentInput[] = [{ ...base, purpose: "booking", granted: true, statement: bookingStatement(opts.hostName) }];
  if (opts.whatsappOptIn) lines.push({ ...base, purpose: "whatsapp_updates", granted: true, statement: opts.whatsappStatement });
  if (opts.smsOptIn && opts.smsStatement) lines.push({ ...base, purpose: "sms_updates", granted: true, statement: opts.smsStatement });
  for (const q of opts.questions.filter((x) => x.kind === "consent")) {
    const answer = opts.answers.find((a) => a.questionId === q.id)?.answer.trim() ?? "";
    lines.push({ ...base, purpose: "host_question", granted: answer !== "", statement: q.label.slice(0, 2000) });
  }
  return lines;
}

type Db = Pick<pg.PoolClient, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Writes the lines inside the booking's own transaction, so a booking never exists without its log. */
export async function insertConsent(db: Db, row: { hostId: string; bookingId: string; inviteeId: string; email: string; locale: string }, lines: ConsentInput[]): Promise<void> {
  if (lines.length === 0) return;
  await db.query(
    `insert into consent_records (host_id, booking_id, invitee_id, email, purpose, granted, statement, notice_version, channel, locale)
     select $1, $2, $3, $4, x.purpose, x.granted, x.statement, x.notice_version, x.channel, $5
     from jsonb_to_recordset($6::jsonb) as x(purpose text, granted boolean, statement text, notice_version text, channel text)`,
    [row.hostId, row.bookingId, row.inviteeId, row.email, row.locale,
      JSON.stringify(lines.map((l) => ({ purpose: l.purpose, granted: l.granted, statement: l.statement, notice_version: l.noticeVersion, channel: l.channel })))]);
}

/** A host's consent log for one client (by email, any case), oldest first. Only that host's rows. */
export async function listConsents(db: Pick<pg.Pool, "query">, hostId: string, email: string): Promise<ConsentRecord[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    `select id, booking_id, purpose, granted, statement, notice_version, channel, locale, recorded_at
     from consent_records where host_id = $1 and email = $2 order by recorded_at, booking_id, purpose`, [hostId, email]);
  return rows.map((r) => ({
    id: r.id, bookingId: r.booking_id, purpose: r.purpose, granted: r.granted, statement: r.statement, noticeVersion: r.notice_version,
    channel: r.channel, locale: r.locale, recordedAt: r.recorded_at,
  }));
}
