import type pg from "pg";
import { NotFoundError } from "../data/types";

// Reviews on the public booking page (db/migrations/0071_public_reviews.sql). Three switches must all be on: the guest's
// consent on the feedback form, the host's choice to show that review, and the host's "show reviews on my page".

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Newest reviews shown on the page. */
export const PUBLIC_LIMIT = 6;

const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((g) => g.segment);

/** How a guest is named on a public review: first name and last initial ("Meera I."), or the one name they gave. */
export function publicName(fullName: string): string | null {
  const words = fullName.replace(/[\p{C}]/gu, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const first = graphemes(words[0]).slice(0, 30).join("");
  if (words.length === 1) return first;
  return `${first} ${graphemes(words[words.length - 1])[0]}.`;
}

export interface PublicReview { rating: number; comment: string | null; name: string | null; createdAt: Date }

/** What the booking page shows: nothing unless the host switched reviews on and has shown at least one consented review. */
export async function publicReviews(db: Db, hostId: string): Promise<{ reviews: PublicReview[]; average: number; count: number } | null> {
  if (!UUID.test(hostId)) return null;
  const shown = "f.host_id = $1 and f.host_shown and f.public_consent_at is not null and exists (select 1 from profiles p where p.user_id = f.host_id and p.show_reviews)";
  const [{ rows }, { rows: [agg] }] = await Promise.all([
    db.query(`select f.rating, f.comment, f.public_name, f.created_at from booking_feedback f where ${shown} order by f.created_at desc limit ${PUBLIC_LIMIT}`, [hostId]),
    db.query(`select count(*)::int as n, avg(f.rating)::float as avg from booking_feedback f where ${shown}`, [hostId]),
  ]);
  if (!agg.n) return null;
  return {
    reviews: rows.map((r) => ({ rating: r.rating, comment: r.comment ?? null, name: r.public_name ?? null, createdAt: r.created_at })),
    average: Math.round(agg.avg * 10) / 10, count: agg.n,
  };
}

/** Shows or hides one review. Only the host's own, and only one the guest agreed to show; anything else is NotFoundError. */
export async function setReviewShown(db: Db, hostId: string, bookingId: string, shown: boolean): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(bookingId)) throw new NotFoundError("Review");
  const { rowCount } = await db.query(
    "update booking_feedback set host_shown = $3 where booking_id = $1 and host_id = $2 and (public_consent_at is not null or not $3)", [bookingId, hostId, shown]);
  if (!rowCount) throw new NotFoundError("Review");
}

export async function getShowReviews(db: Db, hostId: string): Promise<boolean> {
  if (!UUID.test(hostId)) return false;
  const { rows: [r] } = await db.query("select show_reviews from profiles where user_id = $1", [hostId]);
  return r?.show_reviews === true;
}

export async function setShowReviews(db: Db, hostId: string, on: boolean, now: Date): Promise<void> {
  if (!UUID.test(hostId)) throw new NotFoundError("Host");
  await db.query(
    `insert into profiles (user_id, show_reviews, updated_at) values ($1, $2, $3)
     on conflict (user_id) do update set show_reviews = $2, updated_at = $3`, [hostId, on, now]);
}
