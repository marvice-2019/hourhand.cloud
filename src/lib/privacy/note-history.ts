import { randomUUID } from "node:crypto";
import type pg from "pg";
import { seal, unseal } from "../crypto/seal";

// Edit history of private notes. Each save or clear records who and when; the text of a version is kept (sealed like
// the note) only while the owner has "keep versions" on. Turning it off deletes the versions already kept, so the only
// copy of a note is the current one. Owner only, like the notes: never shown to a Duo second person, never mailed.

type Db = Pick<pg.PoolClient, "query">;

/** Which note: a client's general note (by email) or the session note on one booking. */
export type NoteSubject = { email: string } | { bookingId: string };

export interface NoteRevision {
  id: string;
  /** The client email (client note) or the booking id (session note) the revision belongs to. */
  email: string | null;
  bookingId: string | null;
  /** Who saved it; null when that account has since been deleted. */
  actorId: string | null;
  actorName: string | null;
  action: "saved" | "cleared";
  /** The text as saved, only when "keep versions" was on and still is. */
  text: string | null;
  at: Date;
}

const revisionAad = (id: string, hostId: string) => `note_revision:${hostId}:${id}`;

export async function getKeepVersions(db: Db, hostId: string): Promise<boolean> {
  const { rows: [r] } = await db.query("select keep_versions from note_settings where user_id = $1", [hostId]);
  return r?.keep_versions === true;
}

/** Turns "keep versions" on or off. Off deletes every version text already kept for this host; who/when stays. */
export async function setKeepVersions(db: Db, hostId: string, on: boolean): Promise<void> {
  await db.query(
    `insert into note_settings (user_id, keep_versions) values ($1, $2)
     on conflict (user_id) do update set keep_versions = $2, updated_at = now()`, [hostId, on]);
  if (!on) await db.query("update note_revisions set text_sealed = null where host_id = $1 and text_sealed is not null", [hostId]);
}

/** Records one save (text) or clear (null) of a note. Call inside the transaction that writes the note. */
export async function recordRevision(db: Db, key: Buffer, row: { hostId: string; actorId: string; subject: NoteSubject; text: string | null }): Promise<void> {
  const id = randomUUID();
  const keep = row.text !== null && (await getKeepVersions(db, row.hostId));
  const email = "email" in row.subject ? row.subject.email : null;
  const bookingId = "bookingId" in row.subject ? row.subject.bookingId : null;
  await db.query(
    `insert into note_revisions (id, host_id, email, booking_id, actor_id, action, text_sealed) values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, row.hostId, email, bookingId, row.actorId, row.text === null ? "cleared" : "saved", keep ? seal(key, row.text, revisionAad(id, row.hostId)) : null]);
}

/**
 * A host's revisions for a client note (by email, any case) or for session notes on some bookings, newest first.
 * Only that host's rows; version texts are opened with the key.
 */
export async function listRevisions(db: Db, key: Buffer, hostId: string, subject: { email: string } | { bookingIds: string[] }): Promise<NoteRevision[]> {
  const where = "email" in subject ? "r.email = $2" : "r.booking_id = any($2::uuid[])";
  const arg = "email" in subject ? subject.email : subject.bookingIds;
  if (Array.isArray(arg) && arg.length === 0) return [];
  const { rows } = await db.query(
    `select r.id, r.email, r.booking_id, r.actor_id, u.name as actor_name, r.action, r.text_sealed, r.created_at
     from note_revisions r left join users u on u.id = r.actor_id
     where r.host_id = $1 and ${where} order by r.created_at desc, r.id`, [hostId, arg]);
  return rows.map((r) => ({
    id: r.id, email: r.email, bookingId: r.booking_id, actorId: r.actor_id, actorName: r.actor_name ?? null, action: r.action,
    text: r.text_sealed ? unseal<string>(key, r.text_sealed as Buffer, revisionAad(r.id, hostId)) : null, at: r.created_at,
  }));
}
