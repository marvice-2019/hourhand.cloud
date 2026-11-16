import type pg from "pg";
import { renderPracticeInviteMail, type RenderedMail } from "../mail/templates";

// Emails the Clinic plan sends, rendered by the job worker. Kinds start with "practice_" so the worker hands them here.

export type ClinicMailKind = "practice_invite";

export function isClinicMail(kind: string): kind is ClinicMailKind {
  return kind === "practice_invite";
}

type Row = { kind: string; recipient: string; dedupe_key: string };

export async function renderClinicMail(pool: Pick<pg.Pool, "query">, c: Row, baseUrl: string): Promise<RenderedMail | { skip: string }> {
  if (c.kind === "practice_invite") {
    const m = /^practice:([0-9a-f-]{36}):([0-9a-f-]{36}):/.exec(c.dedupe_key);
    if (!m) return { skip: "not a practice invitation" };
    const { rows: [r] } = await pool.query(
      `select p.name as practice_name, o.name as owner_name, o.email as owner_email, x.role
       from practice_members x join practices p on p.id = x.practice_id join users o on o.id = p.owner_id
       where x.id = $1 and p.id = $2 and x.email = $3 and x.accepted_at is null and o.deleted_at is null and practice_is_live(p.id)`,
      [m[2], m[1], c.recipient]);
    if (!r) return { skip: "invitation withdrawn or already accepted" };
    return renderPracticeInviteMail({ practiceName: r.practice_name, inviterName: r.owner_name, replyTo: r.owner_email, role: r.role, url: `${baseUrl}/sign-in` });
  }
  return { skip: `unknown clinic email ${c.kind}` };
}
