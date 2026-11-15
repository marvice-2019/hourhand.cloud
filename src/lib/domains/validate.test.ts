import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./validate";

const ok = (input: string) => normalizeDomain(input);

describe("normalizeDomain", () => {
  it("accepts subdomains and root domains, lowercased, with no trailing dot", () => {
    expect(ok("book.coachname.com")).toEqual({ ok: true, domain: "book.coachname.com" });
    expect(ok("  Book.CoachName.COM.  ")).toEqual({ ok: true, domain: "book.coachname.com" });
    expect(ok("coachname.co.in")).toEqual({ ok: true, domain: "coachname.co.in" });
    expect(ok("a-b.c-d.example.org")).toEqual({ ok: true, domain: "a-b.c-d.example.org" });
  });

  it("keeps only the hostname of a pasted URL", () => {
    expect(ok("https://Book.Coach.com/priya?x=1#y")).toEqual({ ok: true, domain: "book.coach.com" });
    expect(ok("http://book.coach.com:8080")).toEqual({ ok: true, domain: "book.coach.com" });
  });

  it("encodes international names as punycode", () => {
    expect(ok("termine.bücher.de")).toEqual({ ok: true, domain: "termine.xn--bcher-kva.de" });
    expect(ok("बुक.भारत")).toMatchObject({ ok: true });
    expect((ok("बुक.भारत") as { domain: string }).domain).toMatch(/^xn--[a-z0-9-]+\.xn--[a-z0-9-]+$/);
  });

  it("refuses Hourhand's own domain and anything under it", () => {
    for (const d of ["hourhand.cloud", "HOURHAND.CLOUD", "www.hourhand.cloud", "domains.hourhand.cloud", "evil.domains.hourhand.cloud", "x.hourhand.cloud."]) {
      expect(ok(d)).toEqual({ ok: false, error: "ours" });
    }
    expect(normalizeDomain("app.staging.example.net", ["staging.example.net"])).toEqual({ ok: false, error: "ours" });
    // A look-alike that merely ends in the same letters is someone else's domain.
    expect(ok("nothourhand.cloud")).toEqual({ ok: true, domain: "nothourhand.cloud" });
  });

  it("refuses IP addresses in every spelling", () => {
    for (const d of ["127.0.0.1", "10.0.0.5", "http://192.168.1.1/", "::1", "[::1]", "http://[2001:db8::1]:443/", "１２７.0.0.1"]) {
      expect(ok(d)).toMatchObject({ ok: false, error: "ip" });
    }
    expect(ok("1.2.3.4.5")).toMatchObject({ ok: false });
  });

  it("refuses localhost and names that never resolve publicly", () => {
    for (const d of ["localhost", "app.localhost", "printer.local", "db.internal", "site.test", "x.invalid", "x.example", "abc.onion"]) {
      expect(ok(d)).toMatchObject({ ok: false });
    }
    expect(ok("localhost")).toMatchObject({ error: "no_tld" });
    expect(ok("app.localhost")).toMatchObject({ error: "reserved" });
  });

  it("refuses wildcards, single labels and malformed names", () => {
    expect(ok("*.coach.com")).toEqual({ ok: false, error: "wildcard" });
    expect(ok("book.*.com")).toEqual({ ok: false, error: "wildcard" });
    expect(ok("coachname")).toEqual({ ok: false, error: "no_tld" });
    for (const d of ["-book.coach.com", "book-.coach.com", "book..coach.com", "bo ok.coach.com", "book_1.coach.com", "user@coach.com", "coach.123", ".coach.com"]) {
      expect(ok(d)).toMatchObject({ ok: false });
    }
    expect(ok("")).toEqual({ ok: false, error: "empty" });
    expect(normalizeDomain(undefined)).toEqual({ ok: false, error: "empty" });
  });

  it("refuses over-long labels and names", () => {
    expect(ok(`${"a".repeat(64)}.com`)).toMatchObject({ ok: false });
    expect(ok(`${"a".repeat(63)}.com`)).toMatchObject({ ok: true });
    expect(ok(`${Array(60).fill("abcd").join(".")}.com`)).toMatchObject({ ok: false, error: "too_long" });
  });
});
