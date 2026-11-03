import type { NextConfig } from "next";
import { buildCommit } from "./src/lib/build-info";

// Pages a host or the app itself uses may never be framed by another site (clickjacking). Guest booking pages may:
// hosts embed them on their own websites with /embed.js.
const NO_FRAMING = [{ key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }];

// Marketing pages are static files in public/site, served at clean URLs. They are rewritten before the filesystem
// and dynamic routes so a host slug can never shadow them (the slugs are also reserved in src/lib/auth/slug.ts).
const SITE_PAGES = ["coaches", "tutors", "therapists", "refunds", "grievance"];
// "/" itself is src/app/route.ts: it redirects signed-in hosts to the dashboard and serves public/site/index.html to everyone else.

const nextConfig: NextConfig = {
  // Baked in at build time so /api/health can say which version is live.
  env: { HOURHAND_BUILD_COMMIT: buildCommit() ?? "", HOURHAND_BUILT_AT: new Date().toISOString() },
  // A profile photo (up to 2 MB) goes up through a server action; the default limit is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  async rewrites() {
    return {
      beforeFiles: [
        ...SITE_PAGES.map((page) => ({ source: `/${page}`, destination: `/site/${page}/index.html` })),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    const framing = ["/", "/dashboard/:path*", "/sign-in/:path*", "/login/:path*", "/onboarding/:path*", "/api/:path*", "/privacy", "/terms",
      ...SITE_PAGES.map((page) => `/${page}`)]
      .map((source) => ({ source, headers: NO_FRAMING }));
    return [
      ...framing,
      // The HTML must revalidate so a deploy shows at once (headers match the requested path, not the rewrite target);
      // fonts are content-stable, CSS/JS carry a ?v= query.
      ...SITE_PAGES.map((page) => ({ source: `/${page}`, headers: [{ key: "Cache-Control", value: "no-cache" }] })),
      { source: "/assets/fonts/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/assets/:file(.*\\.(?:css|js|svg))", headers: [{ key: "Cache-Control", value: "public, max-age=604800" }] },
    ];
  },
};

export default nextConfig;
