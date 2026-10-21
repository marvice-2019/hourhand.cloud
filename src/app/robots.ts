import type { MetadataRoute } from "next";

const base = (process.env.BETTER_AUTH_URL ?? "https://hourhand.cloud").replace(/\/+$/, "");

/** Hosts' booking pages are public and may be crawled; anything behind a personal token or a sign-in stays out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard/", "/onboarding/", "/b/", "/l/", "/p/", "/invoice/", "/offline"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
