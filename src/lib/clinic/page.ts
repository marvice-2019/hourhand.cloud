import type pg from "pg";
import { practiceBySlug, type Practice } from "./practices";
import { listServices, type PracticeService } from "./services";

// What the public practice page (hourhand.cloud/<practice-slug>) shows. Only a live practice has a page, and only
// practitioners who accepted, take sessions, are on the page and still have an open account are listed.

type Db = Pick<pg.Pool, "query">;

export interface PageOffer { name: string; slug: string; durationMinutes: number; priceMinor: number | null; serviceId: string | null }

export interface PagePractitioner {
  userId: string; name: string; slug: string; headline: string | null; hasPhoto: boolean; photoVersion: number;
  offers: PageOffer[];
}

export interface PracticePageData {
  practice: Practice;
  practitioners: PagePractitioner[];
  /** Each service with the practitioners offering it (only services someone listed offers). */
  services: (PracticeService & { offers: { practitioner: PagePractitioner; offer: PageOffer }[] })[];
}

/** The page's content, or null when there's no live practice at that slug. */
export async function practicePage(db: Db, slug: string): Promise<PracticePageData | null> {
  const found = await practiceBySlug(db, slug);
  if (!found || !found.live) return null;
  const { live: _live, ...practice } = found;
  void _live;
  const { rows } = await db.query(
    `select u.id, u.name, u.slug, p.headline, ph.updated_at as photo_at
     from practice_members m join users u on u.id = m.user_id
     left join profiles p on p.user_id = u.id left join profile_photos ph on ph.user_id = u.id
     where m.practice_id = $1 and m.accepted_at is not null and m.practises and m.active and u.deleted_at is null
     order by m.position, m.accepted_at`, [practice.id]);
  const ids = rows.map((r) => r.id as string);
  const { rows: ets } = ids.length === 0 ? { rows: [] } : await db.query(
    `select e.user_id, e.name, e.slug, e.duration_minutes, e.price_minor, l.service_id
     from event_types e left join practice_service_event_types l on l.event_type_id = e.id
       and l.service_id in (select id from practice_services where practice_id = $2)
     where e.user_id = any($1::uuid[]) and e.active and not e.hidden and e.kind <> 'one_off'
     order by e.position, e.created_at`, [ids, practice.id]);
  const practitioners: PagePractitioner[] = rows.map((r) => ({
    userId: r.id, name: r.name, slug: r.slug, headline: r.headline ?? null, hasPhoto: r.photo_at !== null,
    photoVersion: r.photo_at ? new Date(r.photo_at).getTime() : 0,
    offers: ets.filter((e) => e.user_id === r.id).map((e) => ({
      name: e.name, slug: e.slug, durationMinutes: e.duration_minutes, priceMinor: e.price_minor, serviceId: e.service_id ?? null,
    })),
  }));
  const services = (await listServices(db, practice.id))
    .map((s) => ({ ...s, offers: practitioners.flatMap((p) => p.offers.filter((o) => o.serviceId === s.id).map((offer) => ({ practitioner: p, offer }))) }))
    .filter((s) => s.offers.length > 0);
  return { practice, practitioners, services };
}

/** schema.org markup: the practice as a medical/professional business with its practitioners as members. */
export function practiceJsonLd(baseUrl: string, d: PracticePageData): string {
  const url = `${baseUrl}/${d.practice.slug}`;
  const data = {
    "@context": "https://schema.org", "@type": "ProfessionalService", name: d.practice.name, url,
    ...(d.practice.about ? { description: d.practice.about.slice(0, 300) } : {}),
    employee: d.practitioners.map((p) => ({ "@type": "Person", name: p.name, url: `${baseUrl}/${p.slug}`, ...(p.headline ? { jobTitle: p.headline } : {}) })),
    makesOffer: d.services.map((s) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name: s.name, ...(s.description ? { description: s.description } : {}) } })),
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
