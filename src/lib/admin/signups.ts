import type pg from "pg";

// Who registered, for the admin overview (B17): new hosts per day over the last 30 days (India days), and how hosts
// sign in. Counts only; names stay on the Hosts page.

type Db = Pick<pg.Pool, "query">;

export interface Signups { days: { day: string; count: number }[]; methods: { method: string; hosts: number }[] }

const METHOD_NAMES: Record<string, string> = { google: "Google", microsoft: "Microsoft", credential: "Email and password", "phone-number": "Phone" };

export async function signups(db: Db, now: Date, days = 30): Promise<Signups> {
  const [{ rows }, { rows: methods }] = await Promise.all([
    db.query(
      `with span as (select generate_series(($1::timestamptz at time zone 'Asia/Kolkata')::date - ($2::int - 1), ($1::timestamptz at time zone 'Asia/Kolkata')::date, '1 day')::date as day)
       select to_char(s.day, 'YYYY-MM-DD') as day, count(u.id)::int as count
       from span s left join users u on (u.created_at at time zone 'Asia/Kolkata')::date = s.day
       group by s.day order by s.day`, [now, days]),
    // Email links make no account row, so a host with none signed in by emailed link.
    db.query(
      `select coalesce(a.provider_id, 'email-link') as method, count(distinct u.id)::int as hosts
       from users u left join auth_accounts a on a.user_id = u.id where u.deleted_at is null
       group by 1 order by 2 desc`),
  ]);
  return {
    days: rows.map((r) => ({ day: r.day, count: r.count })),
    methods: methods.map((r) => ({ method: METHOD_NAMES[r.method] ?? (r.method === "email-link" ? "Emailed sign-in link" : r.method), hosts: r.hosts })),
  };
}

/** A CSV cell: quoted, inner quotes doubled, and a leading = + - @ (or tab/CR) neutralised so a spreadsheet can't run it. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",");
