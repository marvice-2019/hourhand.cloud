import { describe, expect, it } from "vitest";
import { appHostsFrom, normalizeHost, routeRequest, TtlCache, type RouteDeps } from "./routing";
import type { DomainRoute } from "./store";

// Two hosts with their own domains, plus one whose domain isn't serving (lapsed or not verified).
const PRIYA: DomainRoute = { userId: "u-priya", slug: "priya", serving: true };
const ARJUN: DomainRoute = { userId: "u-arjun", slug: "arjun", serving: true };
const LAPSED: DomainRoute = { userId: "u-meera", slug: "meera", serving: false };
const DOMAINS: Record<string, DomainRoute> = { "book.priya.in": PRIYA, "arjun.coach": ARJUN, "book.meera.com": LAPSED };
const TOKENS: Record<string, string> = { tokpriya: "u-priya", tokarjun: "u-arjun" };

const lookups: string[] = [];
const deps: RouteDeps = {
  appHosts: appHostsFrom("https://hourhand.cloud"),
  appOrigin: "https://hourhand.cloud",
  lookupDomain: async (h) => { lookups.push(h); return DOMAINS[h] ?? null; },
  bookingHostForToken: async (t) => TOKENS[t] ?? null,
};
const route = (host: string, path: string, search = "") => routeRequest({ host: normalizeHost(host), pathname: path, search }, deps);

describe("routeRequest on hourhand.cloud and local addresses", () => {
  it("passes everything through without a lookup", async () => {
    lookups.length = 0;
    for (const host of ["hourhand.cloud", "www.hourhand.cloud", "localhost:3000", "127.0.0.1:3000", "0.0.0.0:3000", "[::1]:3000"]) {
      expect(await route(host, "/dashboard")).toEqual({ kind: "next" });
    }
    expect(lookups).toEqual([]);
  });

  it("passes an unknown hostname through unchanged", async () => {
    expect(await route("random.example.net", "/priya")).toEqual({ kind: "next" });
  });
});

describe("routeRequest on a host's own domain", () => {
  it("serves the host's profile at the root and their booking pages under their slug", async () => {
    expect(await route("Book.Priya.in", "/")).toEqual({ kind: "rewrite", pathname: "/priya" });
    expect(await route("book.priya.in", "/priya")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/priya/intro-call")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/priya/intro-call/booked")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/_next/static/chunks/a.js")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/api/slots")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/api/bookings")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/api/photo/priya")).toEqual({ kind: "next" });
  });

  it("never serves another host's pages: those go to hourhand.cloud", async () => {
    expect(await route("book.priya.in", "/arjun")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/arjun" });
    expect(await route("book.priya.in", "/arjun/intro-call", "?lang=hi")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/arjun/intro-call?lang=hi" });
    expect(await route("book.priya.in", "/api/photo/arjun")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/api/photo/arjun" });
    // A slug that merely starts with the host's slug is someone else.
    expect(await route("book.priya.in", "/priyanka")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/priyanka" });
    expect(await route("arjun.coach", "/")).toEqual({ kind: "rewrite", pathname: "/arjun" });
    expect(await route("arjun.coach", "/priya")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/priya" });
  });

  it("opens a manage link only when the booking is this host's", async () => {
    expect(await route("book.priya.in", "/b/tokpriya")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/b/tokpriya/calendar.ics")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/api/b/tokpriya/cancel")).toEqual({ kind: "next" });
    expect(await route("book.priya.in", "/b/tokarjun")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/b/tokarjun" });
    expect(await route("book.priya.in", "/api/b/tokarjun/reschedule")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/api/b/tokarjun/reschedule" });
    expect(await route("book.priya.in", "/b/nosuchtoken")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/b/nosuchtoken" });
  });

  it("sends the dashboard, sign-in and auth to hourhand.cloud", async () => {
    for (const path of ["/dashboard", "/dashboard/plan", "/sign-in", "/api/auth/session", "/api/auth/callback/google", "/onboarding/hours", "/privacy", "/coaches", "/l/abc", "/api/webhooks/razorpay"]) {
      expect(await route("book.priya.in", path)).toEqual({ kind: "redirect", url: `https://hourhand.cloud${path}` });
    }
  });

  it("sends visitors of a domain that isn't serving to the host's page on hourhand.cloud", async () => {
    expect(await route("book.meera.com", "/")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/meera" });
    expect(await route("book.meera.com", "/meera/intro", "?x=1")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/meera/intro?x=1" });
    expect(await route("book.meera.com", "/dashboard")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/meera" });
    expect(await route("book.meera.com", "/b/tokpriya")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/meera" });
  });

  it("doesn't let a slug that names an app route open that route", async () => {
    const d: RouteDeps = { ...deps, lookupDomain: async () => ({ userId: "u-x", slug: "pkg", serving: true }) };
    expect(await routeRequest({ host: "x.coach", pathname: "/pkg/123", search: "" }, d)).toEqual({ kind: "redirect", url: "https://hourhand.cloud/pkg/123" });
    expect(await routeRequest({ host: "x.coach", pathname: "/", search: "" }, d)).toEqual({ kind: "rewrite", pathname: "/pkg" });
  });
});

describe("normalizeHost", () => {
  it("lowercases, drops the port and the root dot, and refuses junk", () => {
    expect(normalizeHost("Book.Priya.IN:443")).toBe("book.priya.in");
    expect(normalizeHost("book.priya.in.")).toBe("book.priya.in");
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost("bad host/")).toBeNull();
  });
});

describe("TtlCache", () => {
  it("serves a cached value until it expires, then loads again", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<number>(30_000, 10, () => now);
    const load = async () => ++loads;
    expect(await cache.get("a", load)).toBe(1);
    now = 29_999;
    expect(await cache.get("a", load)).toBe(1);
    now = 30_000;
    expect(await cache.get("a", load)).toBe(2);
  });

  it("keeps each key's value separate and stays within its size", async () => {
    const cache = new TtlCache<string>(60_000, 2);
    expect(await cache.get("book.priya.in", async () => "priya")).toBe("priya");
    expect(await cache.get("arjun.coach", async () => "arjun")).toBe("arjun");
    expect(await cache.get("book.priya.in", async () => "WRONG")).toBe("priya");
    expect(await cache.get("third.coach", async () => "third")).toBe("third");
    // The oldest entry made room; it is loaded fresh, never confused with another key.
    expect(await cache.get("book.priya.in", async () => "priya-again")).toBe("priya-again");
  });
});
