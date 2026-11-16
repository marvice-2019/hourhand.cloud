import type { Metadata } from "next";
import QRCode from "qrcode";
import { formatMoney } from "@/lib/billing/plans";
import type { Profile } from "@/lib/profile";

// The host's booking link as it goes out on Instagram, Google Business Profile and printed QR codes, plus what those
// apps show when the link is pasted: the page's meta tags and the share card's content.

/** Where a link is shared. Each gets its own utm_source so booking analytics can tell them apart. */
export type ShareChannel = "instagram" | "google_business" | "qr";

const UTM: Record<ShareChannel, { source: string; medium: string }> = {
  // The bio link, the Story link sticker or a post: all "social".
  instagram: { source: "instagram", medium: "social" },
  // The appointment / booking link on the Business Profile in Search and Maps: unpaid, so "organic".
  google_business: { source: "google_business", medium: "organic" },
  // Printed at the counter, on a card or a flyer.
  qr: { source: "qr", medium: "offline" },
};

/** The page's public URL: base (no trailing slash needed) plus the host's slug. */
export function pageUrl(base: string, slug: string): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

/** The booking page link tagged for one channel, e.g. https://hourhand.cloud/priya?utm_source=instagram&utm_medium=social. */
export function channelLink(base: string, slug: string, channel: ShareChannel): string {
  const url = new URL(pageUrl(base, slug));
  url.searchParams.set("utm_source", UTM[channel].source);
  url.searchParams.set("utm_medium", UTM[channel].medium);
  return url.toString();
}

/** A QR code for `text` as a self-contained SVG. Medium error correction survives a smudged print. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#1f1a14", light: "#ffffff" } });
}

/** What the page says about the host in one line: the headline, else the start of the bio, else a plain line. */
export function shareDescription(name: string, profile: Pick<Profile, "headline" | "bio"> | null): string {
  const text = profile?.headline ?? profile?.bio ?? `Book a time with ${name}.`;
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
}

/**
 * Meta tags for the host's page. Instagram's and WhatsApp's link previews read og:*, X reads twitter:*; the image
 * itself comes from app/[slug]/opengraph-image.tsx, which Next adds as og:image.
 */
export function hostMetadata(o: { slug: string; name: string; profile: Pick<Profile, "headline" | "bio"> | null; description?: string }): Metadata {
  const description = o.description ?? shareDescription(o.name, o.profile);
  const title = `${o.name}${o.profile?.headline ? ` · ${o.profile.headline}` : ""}`;
  const path = `/${o.slug}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "profile", siteName: "Hourhand", url: path, title: `Book ${o.name}`, description },
    twitter: { card: "summary_large_image", title: `Book ${o.name}`, description },
  };
}

/** Only what the public page already shows: no email, phone, WhatsApp number or hidden services ever reach the card. */
export interface ShareCard {
  name: string;
  initials: string;
  headline: string | null;
  area: string | null;
  /** A data: URL of the host's photo, or null to draw their initials. */
  photo: string | null;
  services: { name: string; detail: string }[];
  /** e.g. hourhand.cloud/priya */
  link: string;
}

interface CardService { name: string; durationMinutes: number; priceMinor: number | null; active: boolean; hidden: boolean; kind?: string; position: number }

/** Photo types the image renderer can draw. WebP isn't one, so a WebP photo falls back to initials. */
const DRAWABLE = new Set(["image/png", "image/jpeg"]);

export function shareCard(o: {
  base: string;
  host: { name: string; slug: string };
  profile: Pick<Profile, "headline" | "area"> | null;
  photo: { mime: string; data: Uint8Array } | null;
  services: CardService[];
}): ShareCard {
  const services = o.services
    .filter((s) => s.active && !s.hidden && s.kind !== "one_off")
    .sort((a, b) => a.position - b.position)
    .slice(0, 3)
    .map((s) => ({ name: clip(s.name, 48), detail: `${s.durationMinutes} min · ${s.priceMinor !== null ? formatMoney(s.priceMinor, "INR") : "Free"}` }));
  const words = o.host.name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  return {
    name: clip(o.host.name, 40),
    initials,
    headline: o.profile?.headline ? clip(o.profile.headline, 90) : null,
    area: o.profile?.area ? clip(o.profile.area, 60) : null,
    photo: o.photo && DRAWABLE.has(o.photo.mime) ? `data:${o.photo.mime};base64,${Buffer.from(o.photo.data).toString("base64")}` : null,
    services,
    link: pageUrl(o.base, o.host.slug).replace(/^https?:\/\//, ""),
  };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
