import { isIP } from "node:net";
import type { DomainRoute } from "./store";

// Which response a request on a host's own domain gets. A custom domain serves exactly one host's public booking pages;
// everything else (the dashboard, sign-in, auth, other hosts' pages) goes to Hourhand's own address, so one host's
// domain can never show another host's pages or carry anyone's session.

export type RouteDecision =
  | { kind: "next" }
  | { kind: "rewrite"; pathname: string }
  | { kind: "redirect"; url: string };

export interface RouteDeps {
  /** Hostnames that are Hourhand itself (hourhand.cloud, www.hourhand.cloud): served as usual, never looked up. */
  appHosts: ReadonlySet<string>;
  /** Hourhand's public origin, e.g. https://hourhand.cloud. */
  appOrigin: string;
  lookupDomain(host: string): Promise<DomainRoute | null>;
  bookingHostForToken(token: string): Promise<string | null>;
}

/** Files every page needs, the same for every host. */
const SHARED_FILES = /^\/(?:_next\/|favicon\.ico$|icon\.svg$|icons\/[^/]+$|apple-icon|manifest\.webmanifest$|robots\.txt$|assets\/)/;
/** The JSON endpoints the booking pages call from the browser. They take ids, not a host, and are public on hourhand.cloud too. */
const BOOKING_APIS = new Set(["/api/slots", "/api/bookings", "/api/bookings/pay", "/api/waitlist"]);
/** A manage link and its calendar file, and the guest's manage actions. */
const MANAGE_PAGE = /^\/b\/([^/]+)(?:\/calendar\.ics)?$/;
const MANAGE_API = /^\/api\/b\/([^/]+)\/(?:cancel|reschedule|late)$/;
const PHOTO = /^\/api\/photo\/([^/]+)$/;
/** Top-level routes of the app. A slug equal to one of these (older accounts) must not open that route on a custom domain. */
const APP_ROUTES = new Set(["api", "b", "dashboard", "invoice", "l", "login", "offline", "onboarding", "p", "pkg", "join", "m", "member", "privacy", "sign-in", "terms", "site", "assets"]);

/** "Book.Coach.com:443" → "book.coach.com". Null for a missing or malformed Host header. */
export function normalizeHost(header: string | null): string | null {
  if (!header) return null;
  const h = header.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9.-]{1,253}$/.test(h) || isIP(h.replace(/^\[|\]$/g, "")) ? h : null;
}

/** Local and IP addresses are never custom domains (health checks, the container's own address, development). */
function isLocal(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || isIP(host.replace(/^\[|\]$/g, "")) !== 0;
}

export async function routeRequest(req: { host: string | null; pathname: string; search: string }, deps: RouteDeps): Promise<RouteDecision> {
  const host = req.host;
  if (!host || deps.appHosts.has(host) || isLocal(host)) return { kind: "next" };
  const route = await deps.lookupDomain(host);
  // Not a host's domain: behave as before (Coolify only routes hostnames it knows to this app anyway).
  if (!route) return { kind: "next" };

  const toApp = (path: string) => ({ kind: "redirect" as const, url: `${deps.appOrigin}${path}` });
  const { pathname, search } = req;
  // Not (or no longer) serving: send visitors to the same host's page on Hourhand, keeping booking paths intact.
  if (!route.serving) {
    const own = pathname === `/${route.slug}` || pathname.startsWith(`/${route.slug}/`);
    return toApp(own ? `${pathname}${search}` : `/${route.slug}`);
  }

  if (SHARED_FILES.test(pathname)) return { kind: "next" };
  if (pathname === "/") return { kind: "rewrite", pathname: `/${route.slug}` };
  if (!APP_ROUTES.has(route.slug) && (pathname === `/${route.slug}` || pathname.startsWith(`/${route.slug}/`))) return { kind: "next" };
  if (BOOKING_APIS.has(pathname)) return { kind: "next" };

  const photo = PHOTO.exec(pathname);
  if (photo) return decodeSafe(photo[1]) === route.slug ? { kind: "next" } : toApp(`${pathname}${search}`);

  const manage = MANAGE_PAGE.exec(pathname) ?? MANAGE_API.exec(pathname);
  if (manage) {
    const token = decodeSafe(manage[1]);
    const owner = token ? await deps.bookingHostForToken(token) : null;
    // Another host's booking (or no booking): show it where it belongs, on hourhand.cloud.
    return owner === route.userId ? { kind: "next" } : toApp(`${pathname}${search}`);
  }

  // The dashboard, sign-in, auth, legal pages, other hosts' pages, anything else.
  return toApp(`${pathname}${search}`);
}

function decodeSafe(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** A small time-limited cache for host lookups, so a page and its assets don't each query the database. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 1_000, private readonly clock: () => number = Date.now) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const now = this.clock();
    const hit = this.map.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = await load();
    if (this.map.size >= this.maxEntries) {
      // Drop expired entries first; if all are fresh, the oldest insertion.
      for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
      if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value as string);
    }
    this.map.set(key, { value, expires: now + this.ttlMs });
    return value;
  }

  clear(): void {
    this.map.clear();
  }
}

/** The hostnames Hourhand itself answers to, from its public URL: the apex and its www. */
export function appHostsFrom(baseUrl: string | undefined): Set<string> {
  const hosts = new Set<string>();
  try {
    if (baseUrl) {
      const h = new URL(baseUrl).hostname.toLowerCase();
      hosts.add(h);
      hosts.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`);
    }
  } catch {
    /* a malformed URL adds nothing */
  }
  return hosts;
}
