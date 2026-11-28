import type pg from "pg";
import { publicProducts, type Product } from "./products/products";
import { publicOffer } from "./questions/questions";

type Db = Pick<pg.Pool, "query">;

/** What a host sells besides bookings, as their public profile lists it (B25). */
export interface ProfileOfferings {
  /** "Ask a question" (B19), when the host has it switched on. */
  ask: { priceMinor: number; responseDays: number } | null;
  /** Products on sale (B20) that have something to deliver. */
  products: Product[];
}

/** Both read the same public rules as their own pages, so the profile never links to a page that would 404. */
export async function profileOfferings(db: Db, slug: string): Promise<ProfileOfferings> {
  const [offer, shop] = await Promise.all([publicOffer(db, slug), publicProducts(db, slug)]);
  return {
    ask: offer ? { priceMinor: offer.offer.priceMinor, responseDays: offer.offer.responseDays } : null,
    products: shop?.products ?? [],
  };
}
