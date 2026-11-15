// Custom domains against real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_dom, dropped and
// recreated on every run): saving, uniqueness, DNS check transitions, and host isolation in the request router.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import type { Resolver } from "./dns";
import { appHostsFrom, routeRequest, type RouteDeps } from "./routing";
import { addDomain, checkHostDomain, deleteDomain } from "./service";
import { bookingHostForToken, domainsDue, getDomain, lookupDomainRoute, recordCheck, setDomain } from "./store";

const BASE = process.env.TEST_DATABASE_URL;
const TARGET = "domains.hourhand.cloud";

/** DNS where `pointed` names CNAME to Hourhand and everything else has no record. */
function dnsWith(pointed: string[]): Resolver {
  const none = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  return {
    resolveCname: (h) => (pointed.includes(h) ? Promise.resolve([TARGET]) : none()),
    resolve4: (h) => (h === TARGET ? Promise.resolve(["203.0.113.7"]) : none()),
  };
}
const timeouts: Resolver = {
  resolveCname: () => Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" })),
  resolve4: (h) => (h === TARGET ? Promise.resolve(["203.0.113.7"]) : Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" }))),
};

describe.skipIf(!BASE)("custom domains (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let priya: string;
  let arjun: string;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_dom`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`drop database if exists ${name} with (force)`);
      await c.query(`create database ${name}`);
    } finally {
      await c.end();
    }
    await migrate(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    priya = (await pool.query("insert into users (email, name, slug) values ('priya@example.in', 'Priya', 'priya') returning id")).rows[0].id;
    arjun = (await pool.query("insert into users (email, name, slug) values ('arjun@example.in', 'Arjun', 'arjun') returning id")).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from custom_domains");
    await pool.query("delete from subscriptions");
    await pool.query("delete from addon_subscriptions");
    await pool.query("update users set deleted_at = null");
  });

  /** A paid plan plus the live custom-domain add-on. */
  const paid = async (userId: string) => {
    await pool.query(
      "insert into subscriptions (user_id, plan, interval, provider, provider_subscription_id, status) values ($1, 'solo', 'month', 'razorpay', $2, 'active')",
      [userId, `sub_${userId}`]);
    await pool.query(
      "insert into addon_subscriptions (user_id, addon, provider, provider_subscription_id, status) values ($1, 'domain', 'razorpay', $2, 'active')",
      [userId, `sub_dom_${userId}`]);
  };

  it("needs the add-on on a paid plan to add a domain", async () => {
    const r = await addDomain(pool, priya, "book.priya.in", { resolver: dnsWith(["book.priya.in"]) });
    expect(r).toMatchObject({ ok: false, error: "not_entitled" });
    // A paid plan alone isn't enough.
    await pool.query("insert into subscriptions (user_id, plan, interval, provider, provider_subscription_id, status) values ($1, 'solo', 'month', 'razorpay', 'sub_only_plan', 'active')", [priya]);
    expect(await addDomain(pool, priya, "book.priya.in", { resolver: dnsWith(["book.priya.in"]) })).toMatchObject({ ok: false, error: "not_entitled" });
    expect(await getDomain(pool, priya)).toBeNull();
  });

  it("saves a valid domain and checks it at once: active when the CNAME is there", async () => {
    await paid(priya);
    const r = await addDomain(pool, priya, "https://Book.Priya.in/", { resolver: dnsWith(["book.priya.in"]), now: new Date("2026-11-15T10:00:00Z") });
    expect(r).toMatchObject({ ok: true, domain: { domain: "book.priya.in", status: "active", lastError: null } });
    expect((await getDomain(pool, priya))?.verifiedAt?.toISOString()).toBe("2026-11-15T10:00:00.000Z");
  });

  it("keeps a domain without a record as failed, with the reason", async () => {
    await paid(priya);
    const r = await addDomain(pool, priya, "book.priya.in", { resolver: dnsWith([]) });
    expect(r).toMatchObject({ ok: true, domain: { status: "failed", lastError: expect.stringContaining("No DNS record") } });
  });

  it("refuses invalid input before touching the database", async () => {
    await paid(priya);
    expect(await addDomain(pool, priya, "hourhand.cloud", { resolver: dnsWith([]) })).toMatchObject({ ok: false, error: "invalid" });
    expect(await addDomain(pool, priya, "10.0.0.1", { resolver: dnsWith([]) })).toMatchObject({ ok: false, error: "invalid" });
    expect(await getDomain(pool, priya)).toBeNull();
  });

  it("gives one domain to one host only, whatever the case", async () => {
    await paid(priya);
    await paid(arjun);
    expect(await addDomain(pool, priya, "book.priya.in", { resolver: dnsWith([]) })).toMatchObject({ ok: true });
    expect(await addDomain(pool, arjun, "BOOK.PRIYA.IN", { resolver: dnsWith([]) })).toMatchObject({ ok: false, error: "taken" });
    // The database backs it up: a duplicate is refused, and so is any spelling other than the lowercase one.
    await expect(pool.query("insert into custom_domains (user_id, domain) values ($1, 'book.priya.in')", [arjun])).rejects.toThrow(/duplicate key/);
    await expect(pool.query("insert into custom_domains (user_id, domain) values ($1, 'Book.Priya.In')", [arjun])).rejects.toThrow(/check constraint/);
    expect(await getDomain(pool, arjun)).toBeNull();
  });

  it("replacing a domain starts it again as pending, and reports the one replaced", async () => {
    await setDomain(pool, priya, "book.priya.in");
    await recordCheck(pool, (await getDomain(pool, priya))!, { ok: true, via: "cname" });
    expect(await setDomain(pool, priya, "priya.coach")).toEqual({ result: "ok", replaced: "book.priya.in" });
    expect(await getDomain(pool, priya)).toMatchObject({ domain: "priya.coach", status: "pending", verifiedAt: null, lastError: null });
  });

  it("a DNS hiccup never takes a live domain down; a real miss does", async () => {
    await setDomain(pool, priya, "book.priya.in");
    expect(await checkHostDomain(pool, priya, dnsWith(["book.priya.in"]))).toMatchObject({ status: "active" });
    expect(await checkHostDomain(pool, priya, timeouts)).toMatchObject({ status: "active", lastError: expect.stringContaining("didn't answer") });
    expect(await checkHostDomain(pool, priya, dnsWith([]))).toMatchObject({ status: "failed" });
    // Fixed again: back to active, keeping the first verification time.
    const first = (await getDomain(pool, priya))!.verifiedAt;
    expect(await checkHostDomain(pool, priya, dnsWith(["book.priya.in"]))).toMatchObject({ status: "active", lastError: null, verifiedAt: first });
  });

  it("a check that raced a change of domain saves nothing", async () => {
    await setDomain(pool, priya, "book.priya.in");
    const stale = (await getDomain(pool, priya))!;
    await setDomain(pool, priya, "priya.coach");
    expect(await recordCheck(pool, stale, { ok: true, via: "cname" })).toBeNull();
    expect(await getDomain(pool, priya)).toMatchObject({ domain: "priya.coach", status: "pending" });
  });

  it("removing only ever removes the host's own domain", async () => {
    await setDomain(pool, priya, "book.priya.in");
    await setDomain(pool, arjun, "arjun.coach");
    expect(await deleteDomain(pool, priya)).toBe("book.priya.in");
    expect(await deleteDomain(pool, priya)).toBeNull();
    expect(await getDomain(pool, arjun)).toMatchObject({ domain: "arjun.coach" });
  });

  it("lists domains due for a re-check, never-checked first", async () => {
    const now = new Date("2026-11-15T12:00:00Z");
    await setDomain(pool, priya, "book.priya.in");
    await setDomain(pool, arjun, "arjun.coach");
    await recordCheck(pool, (await getDomain(pool, arjun))!, { ok: true, via: "cname" }, new Date("2026-11-15T11:00:00Z"));
    // Arjun's is active and was checked an hour ago; Priya's has never been checked.
    expect((await domainsDue(pool, now, { waitingMs: 5 * 60_000, activeMs: 30 * 60_000 })).map((d) => d.domain)).toEqual(["book.priya.in", "arjun.coach"]);
    expect((await domainsDue(pool, now, { waitingMs: 5 * 60_000, activeMs: 2 * 3_600_000 })).map((d) => d.domain)).toEqual(["book.priya.in"]);
    // A failed domain is checked on the shorter wait.
    await recordCheck(pool, (await getDomain(pool, arjun))!, { ok: false, transient: false, reason: "gone" }, new Date("2026-11-15T11:50:00Z"));
    expect((await domainsDue(pool, now, { waitingMs: 5 * 60_000, activeMs: 2 * 3_600_000 })).map((d) => d.domain)).toEqual(["book.priya.in", "arjun.coach"]);
  });

  describe("routing with the real lookups", () => {
    const deps = (): RouteDeps => ({
      appHosts: appHostsFrom("https://hourhand.cloud"),
      appOrigin: "https://hourhand.cloud",
      lookupDomain: (h) => lookupDomainRoute(pool, h),
      bookingHostForToken: (t) => bookingHostForToken(pool, t),
    });
    const go = (host: string, pathname: string) => routeRequest({ host, pathname, search: "" }, deps());

    it("each domain serves only its own host, and only once verified", async () => {
      await paid(priya);
      await paid(arjun);
      await setDomain(pool, priya, "book.priya.in");
      await setDomain(pool, arjun, "arjun.coach");
      // Not verified yet: visitors go to the host's page on hourhand.cloud.
      expect(await go("book.priya.in", "/")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/priya" });
      await checkHostDomain(pool, priya, dnsWith(["book.priya.in", "arjun.coach"]));
      await checkHostDomain(pool, arjun, dnsWith(["book.priya.in", "arjun.coach"]));
      expect(await go("book.priya.in", "/")).toEqual({ kind: "rewrite", pathname: "/priya" });
      expect(await go("arjun.coach", "/")).toEqual({ kind: "rewrite", pathname: "/arjun" });
      expect(await go("book.priya.in", "/arjun")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/arjun" });
      expect(await go("arjun.coach", "/priya/intro")).toEqual({ kind: "redirect", url: "https://hourhand.cloud/priya/intro" });
    });

    it("a closed account's domain serves nothing", async () => {
      await paid(priya);
      await setDomain(pool, priya, "book.priya.in");
      await checkHostDomain(pool, priya, dnsWith(["book.priya.in"]));
      await pool.query("update users set deleted_at = now() where id = $1", [priya]);
      expect(await lookupDomainRoute(pool, "book.priya.in")).toBeNull();
    });

    it("finds whose booking a manage token is", async () => {
      expect(await bookingHostForToken(pool, "no-such-token")).toBeNull();
    });
  });
});
