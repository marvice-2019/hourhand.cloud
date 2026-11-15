import type { MetadataRoute } from "next";

const base = (process.env.BETTER_AUTH_URL ?? "https://hourhand.cloud").replace(/\/+$/, "");

/** The site's own pages. Hosts' booking pages are reached through their links, not listed here. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    ...["coaches", "tutors", "therapists"].map((page) => ({ url: `${base}/${page}`, changeFrequency: "monthly" as const, priority: 0.8 })),
    { url: `${base}/refunds`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/grievance`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
