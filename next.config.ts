import type { NextConfig } from "next";
import { buildCommit } from "./src/lib/build-info";

// Pages a host or the app itself uses may never be framed by another site (clickjacking). Guest booking pages may:
// hosts embed them on their own websites with /embed.js.
const NO_FRAMING = [{ key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }];

const nextConfig: NextConfig = {
  // Baked in at build time so /api/health can say which version is live.
  env: { HOURHAND_BUILD_COMMIT: buildCommit() ?? "", HOURHAND_BUILT_AT: new Date().toISOString() },
  // A profile photo (up to 2 MB) goes up through a server action; the default limit is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  async headers() {
    return ["/", "/dashboard/:path*", "/sign-in/:path*", "/login/:path*", "/onboarding/:path*", "/api/:path*", "/privacy", "/terms"]
      .map((source) => ({ source, headers: NO_FRAMING }));
  },
};

export default nextConfig;
