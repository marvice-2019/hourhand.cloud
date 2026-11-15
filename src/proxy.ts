import { NextResponse, type NextRequest } from "next/server";
import pg from "pg";
import { appHostsFrom, normalizeHost, routeRequest, TtlCache } from "@/lib/domains/routing";
import { bookingHostForToken, lookupDomainRoute, type DomainRoute } from "@/lib/domains/store";

// Custom domains: a request whose Host is a host's own domain (book.coachname.com) is routed to that host's public
// booking pages, and everything else on that domain is sent to hourhand.cloud. Requests to hourhand.cloud itself,
// localhost and IP addresses pass straight through without a database lookup. Pages still check everything
// themselves; this only decides which address serves what.

const shared = globalThis as typeof globalThis & { __hourhandPool?: pg.Pool };
const pool = (url: string) => (shared.__hourhandPool ??= new pg.Pool({ connectionString: url }));

// Brief, so a newly verified, removed or lapsed domain takes effect within half a minute.
const domains = new TtlCache<DomainRoute | null>(30_000);
const tokens = new TtlCache<string | null>(30_000);

const appOrigin = () => (process.env.BETTER_AUTH_URL || "https://hourhand.cloud").replace(/\/+$/, "");

export async function proxy(request: NextRequest) {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.HOURHAND_DATA !== "postgres") return NextResponse.next();
  const decision = await routeRequest(
    { host: normalizeHost(request.headers.get("host")), pathname: request.nextUrl.pathname, search: request.nextUrl.search },
    {
      appHosts: appHostsFrom(process.env.BETTER_AUTH_URL),
      appOrigin: appOrigin(),
      lookupDomain: (host) => domains.get(host, () => lookupDomainRoute(pool(url), host)),
      bookingHostForToken: (token) => tokens.get(token, () => bookingHostForToken(pool(url), token)),
    },
  ).catch((error) => {
    // The database is down: say so rather than guess which pages a domain may show.
    console.error("[domains] routing lookup failed", error);
    return { kind: "error" as const };
  });
  if (decision.kind === "error") return new NextResponse("Temporarily unavailable", { status: 503, headers: { "retry-after": "30" } });
  if (decision.kind === "redirect") return NextResponse.redirect(decision.url, 307);
  if (decision.kind === "rewrite") {
    const target = request.nextUrl.clone();
    target.pathname = decision.pathname;
    return NextResponse.rewrite(target);
  }
  return NextResponse.next();
}

export const config = {
  // Build output and image optimisation never differ by host.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
