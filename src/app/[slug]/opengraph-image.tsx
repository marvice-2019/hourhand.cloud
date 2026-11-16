import { ImageResponse } from "next/og";
import { ShareCardImage } from "@/components/ShareCardImage";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { getProfile, photoBySlug } from "@/lib/profile";
import { shareCard } from "@/lib/share-links";

// Each host's own share card: their name, photo and first services, shown when /{slug} (or one of its service pages)
// is pasted into Instagram, WhatsApp, Google or X. It carries only what the public page already shows.
export const alt = "Book a time on Hourhand";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Read from the database on each request (no build-time copy); crawlers and the CDN keep it for an hour.
export const dynamic = "force-dynamic";

export default async function HostShareImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const host = await store.getUserBySlug(slug);
  if (!host) return new Response(null, { status: 404 });
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [profile, photo, services] = await Promise.all([
    db ? getProfile(db, host.id) : null,
    db ? photoBySlug(db, host.slug) : null,
    store.listEventTypes(host.id),
  ]);
  const card = shareCard({ base: resolveBaseUrl() ?? "https://hourhand.cloud", host, profile, photo, services });
  return new ImageResponse(<ShareCardImage card={card} />, { ...size, headers: { "cache-control": "public, max-age=3600, stale-while-revalidate=86400" } });
}
