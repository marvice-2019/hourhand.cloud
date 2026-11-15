import { describe, expect, it } from "vitest";
import { checkDomainDns, type Resolver } from "./dns";

const TARGET = "domains.hourhand.cloud";
const err = (code: string) => Object.assign(new Error(code), { code });

/** A resolver from a table: name → records, or an error code to throw. */
function fake(cname: Record<string, string[] | string>, a: Record<string, string[] | string>): Resolver {
  const pick = (table: Record<string, string[] | string>, host: string) => {
    const v = table[host];
    if (v === undefined) return Promise.reject(err("ENODATA"));
    return typeof v === "string" ? Promise.reject(err(v)) : Promise.resolve(v);
  };
  return { resolveCname: (h) => pick(cname, h), resolve4: (h) => pick(a, h) };
}

describe("checkDomainDns", () => {
  it("passes a CNAME to the target, whatever its case or trailing dot", async () => {
    const r = fake({ "book.coach.com": ["Domains.Hourhand.Cloud."] }, { [TARGET]: ["203.0.113.7"] });
    expect(await checkDomainDns("book.coach.com", r)).toEqual({ ok: true, via: "cname" });
  });

  it("passes A records that are exactly the target's (a root domain)", async () => {
    const r = fake({}, { "coach.com": ["203.0.113.7"], [TARGET]: ["203.0.113.7", "203.0.113.8"] });
    expect(await checkDomainDns("coach.com", r)).toEqual({ ok: true, via: "a" });
  });

  it("fails, definitely, a CNAME pointing somewhere else", async () => {
    const r = fake({ "book.coach.com": ["coach.wixdns.net"] }, { "book.coach.com": ["198.51.100.1"], [TARGET]: ["203.0.113.7"] });
    const c = await checkDomainDns("book.coach.com", r);
    expect(c).toMatchObject({ ok: false, transient: false });
    expect((c as { reason: string }).reason).toContain("coach.wixdns.net");
  });

  it("fails an A record set that includes any other address (half the visitors would miss)", async () => {
    const r = fake({}, { "coach.com": ["203.0.113.7", "198.51.100.1"], [TARGET]: ["203.0.113.7"] });
    const c = await checkDomainDns("coach.com", r);
    expect(c).toMatchObject({ ok: false, transient: false });
    expect((c as { reason: string }).reason).toContain("198.51.100.1");
  });

  it("fails, definitely, a name with no records", async () => {
    const r = fake({ "book.coach.com": "ENOTFOUND" }, { "book.coach.com": "ENOTFOUND", [TARGET]: ["203.0.113.7"] });
    expect(await checkDomainDns("book.coach.com", r)).toMatchObject({ ok: false, transient: false, reason: expect.stringContaining("No DNS record") });
  });

  it("treats a lookup that times out as transient, not as a missing record", async () => {
    const r = fake({ "book.coach.com": "ETIMEOUT" }, { "book.coach.com": "ETIMEOUT", [TARGET]: ["203.0.113.7"] });
    expect(await checkDomainDns("book.coach.com", r)).toMatchObject({ ok: false, transient: true });
    const s = fake({ "book.coach.com": "ESERVFAIL" }, { "book.coach.com": "ESERVFAIL", [TARGET]: ["203.0.113.7"] });
    expect(await checkDomainDns("book.coach.com", s)).toMatchObject({ ok: false, transient: true });
  });

  it("never blames the host when Hourhand's own record can't be read", async () => {
    const r = fake({}, { "coach.com": ["203.0.113.7"], [TARGET]: "ETIMEOUT" });
    expect(await checkDomainDns("coach.com", r)).toMatchObject({ ok: false, transient: true });
    const s = fake({}, { "coach.com": ["203.0.113.7"] });
    expect(await checkDomainDns("coach.com", s)).toMatchObject({ ok: false, transient: true });
  });
});
