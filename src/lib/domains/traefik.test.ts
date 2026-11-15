// Traefik files for custom domains: the YAML itself, then (with TEST_DATABASE_URL, own database <name>_tls) the folder
// kept in line with the serving domains and the scheduled re-check, in a temporary folder.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import type { Resolver } from "./dns";
import { recheckDomains } from "./recheck";
import { getDomain, removeDomain, setDomain } from "./store";
import { fileNameFor, reconcileTraefik, safeUpstream, traefikFromEnv, traefikYaml } from "./traefik";

describe("traefikYaml", () => {
  it("writes an https router with a Let's Encrypt certificate, an http-to-https redirect and the app as the service", () => {
    expect(traefikYaml("book.priya.in", "http://hourhand-app:3000")).toBe(`# Managed by Hourhand for "book.priya.in". Don't edit: it is rewritten or deleted when the domain changes.
http:
  routers:
    "hourhand-542eacea23afb758-https":
      rule: "Host(\`book.priya.in\`)"
      entryPoints: ["https"]
      service: "hourhand-542eacea23afb758"
      tls:
        certResolver: "letsencrypt"
    "hourhand-542eacea23afb758-http":
      rule: "Host(\`book.priya.in\`)"
      entryPoints: ["http"]
      middlewares: ["hourhand-542eacea23afb758-to-https"]
      service: "hourhand-542eacea23afb758"
  middlewares:
    "hourhand-542eacea23afb758-to-https":
      redirectScheme:
        scheme: "https"
        permanent: true
  services:
    "hourhand-542eacea23afb758":
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://hourhand-app:3000"
`);
  });

  it("names files by a hash of the domain, never by what the host typed", () => {
    expect(fileNameFor("book.priya.in")).toBe("hourhand-domain-542eacea23afb758.yaml");
    expect(fileNameFor("arjun.coach")).toMatch(/^hourhand-domain-[0-9a-f]{16}\.yaml$/);
    expect(fileNameFor("arjun.coach")).not.toBe(fileNameFor("book.priya.in"));
  });

  it("refuses anything that isn't an exact, valid, normalised domain, so a rule can't be smuggled in", () => {
    for (const bad of ["a.com`) || Host(`evil.com", "a.com\n    evil: true", "Book.Priya.in", "hourhand.cloud", "*.priya.in", "10.0.0.1", "a.com\"", ""]) {
      expect(() => traefikYaml(bad, "http://hourhand-app:3000")).toThrow(/invalid domain/);
    }
  });

  it("accepts only a plain http(s)://host:port upstream", () => {
    expect(safeUpstream("http://hourhand-app:3000")).toBe(true);
    expect(safeUpstream("http://10.0.1.5:3000/")).toBe(true);
    for (const bad of ["hourhand-app:3000", "http://a:3000/path", "http://u:p@a:3000", "http://a:3000\"\n  x: y", "ftp://a", "http://a b:3000"]) expect(safeUpstream(bad)).toBe(false);
    expect(() => traefikYaml("book.priya.in", "http://a:3000\"\nx")).toThrow(/HOURHAND_UPSTREAM_URL/);
  });
});

describe("traefikFromEnv", () => {
  it("says the feature isn't set up when TRAEFIK_DYNAMIC_DIR is unset, instead of falling back", () => {
    expect(traefikFromEnv({})).toEqual({ ok: false, reason: expect.stringContaining("not set up on this server (TRAEFIK_DYNAMIC_DIR is not set)") });
    expect(traefikFromEnv({ TRAEFIK_DYNAMIC_DIR: "/traefik-dynamic" })).toEqual({ ok: false, reason: expect.stringContaining("HOURHAND_UPSTREAM_URL is not set") });
    expect(traefikFromEnv({ TRAEFIK_DYNAMIC_DIR: "/t", HOURHAND_UPSTREAM_URL: "hourhand-app" })).toMatchObject({ ok: false });
    expect(traefikFromEnv({ TRAEFIK_DYNAMIC_DIR: "/t", HOURHAND_UPSTREAM_URL: "http://hourhand-app:3000" })).toEqual({ ok: true, config: { dir: "/t", upstream: "http://hourhand-app:3000" } });
  });
});

const BASE = process.env.TEST_DATABASE_URL;
const TARGET = "domains.hourhand.cloud";

describe.skipIf(!BASE)("Traefik folder and the scheduled re-check (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let priya: string;
  let arjun: string;
  let dir: string;
  const files = async () => (await readdir(dir)).sort();
  const UP = "http://hourhand-app:3000";
  let pointed: string[] = [];
  let timeout = false;
  const resolver: Resolver = {
    resolveCname: (h) => (timeout ? Promise.reject(Object.assign(new Error("t"), { code: "ETIMEOUT" })) : pointed.includes(h) ? Promise.resolve([TARGET]) : Promise.reject(Object.assign(new Error("n"), { code: "ENOTFOUND" }))),
    resolve4: (h) => (h === TARGET ? Promise.resolve(["203.0.113.7"]) : timeout ? Promise.reject(Object.assign(new Error("t"), { code: "ETIMEOUT" })) : Promise.reject(Object.assign(new Error("n"), { code: "ENOTFOUND" }))),
  };

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_tls`;
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
    for (const t of ["custom_domains", "addon_subscriptions", "subscriptions"]) await pool.query(`delete from ${t}`);
    dir = await mkdtemp(join(tmpdir(), "hh-traefik-"));
    // A file Coolify itself keeps in the same folder.
    await writeFile(join(dir, "coolify.yaml"), "http: {}\n");
    pointed = [];
    timeout = false;
    for (const id of [priya, arjun]) {
      await pool.query("insert into subscriptions (user_id, plan, interval, provider, provider_subscription_id, status) values ($1, 'solo', 'month', 'razorpay', $2, 'active')", [id, `sub_${id}`]);
      await pool.query("insert into addon_subscriptions (user_id, addon, provider, provider_subscription_id, status) values ($1, 'domain', 'razorpay', $2, 'active')", [id, `sub_dom_${id}`]);
    }
  });

  const run = (at = "2026-11-20T10:00:00Z") => recheckDomains(pool, resolver, { ok: true, config: { dir, upstream: UP } }, new Date(at));

  it("writes a file only once DNS is verified, and only for that domain", async () => {
    await setDomain(pool, priya, "book.priya.in");
    await setDomain(pool, arjun, "arjun.coach");
    expect(await run()).toEqual({ checked: 2, written: 0, removed: 0 });
    expect(await files()).toEqual(["coolify.yaml"]);
    pointed = ["book.priya.in"];
    expect(await run("2026-11-20T10:06:00Z")).toEqual({ checked: 2, written: 1, removed: 0 });
    expect(await files()).toEqual(["coolify.yaml", fileNameFor("book.priya.in")]);
    expect(await readFile(join(dir, fileNameFor("book.priya.in")), "utf8")).toBe(traefikYaml("book.priya.in", UP));
    expect((await getDomain(pool, arjun))?.status).toBe("failed");
  });

  it("is idempotent, never touches other files and leaves no temporary files", async () => {
    pointed = ["book.priya.in"];
    await setDomain(pool, priya, "book.priya.in");
    await run();
    expect(await reconcileTraefik(pool, { dir, upstream: UP })).toEqual({ written: [], removed: [] });
    expect(await files()).toEqual(["coolify.yaml", fileNameFor("book.priya.in")]);
    // A changed upstream rewrites the file in place.
    expect(await reconcileTraefik(pool, { dir, upstream: "http://hourhand-app-2:3000" })).toEqual({ written: [fileNameFor("book.priya.in")], removed: [] });
    expect(await files()).toEqual(["coolify.yaml", fileNameFor("book.priya.in")]);
  });

  it("a DNS timeout keeps the certificate; a record that's gone removes it", async () => {
    pointed = ["book.priya.in"];
    await setDomain(pool, priya, "book.priya.in");
    await run();
    timeout = true;
    await run("2026-11-20T11:00:00Z");
    expect(await files()).toContain(fileNameFor("book.priya.in"));
    timeout = false;
    pointed = [];
    expect(await run("2026-11-20T12:00:00Z")).toMatchObject({ removed: 1 });
    expect(await files()).toEqual(["coolify.yaml"]);
  });

  it("removes the file when the add-on lapses, the plan lapses, or the domain is removed", async () => {
    pointed = ["book.priya.in", "arjun.coach"];
    await setDomain(pool, priya, "book.priya.in");
    await setDomain(pool, arjun, "arjun.coach");
    await run();
    expect(await files()).toHaveLength(3);
    // Priya cancelled; the paid month ended.
    await pool.query("update addon_subscriptions set cancel_at_period_end = true, current_period_end = '2026-11-30T00:00:00Z' where user_id = $1", [priya]);
    expect(await reconcileTraefik(pool, { dir, upstream: UP }, new Date("2026-11-29T00:00:00Z"))).toEqual({ written: [], removed: [] });
    expect(await reconcileTraefik(pool, { dir, upstream: UP }, new Date("2026-11-30T00:00:00Z"))).toEqual({ written: [], removed: [fileNameFor("book.priya.in")] });
    const later = new Date("2026-12-01T00:00:00Z");
    // Arjun's plan ended.
    await pool.query("update subscriptions set status = 'cancelled' where user_id = $1", [arjun]);
    expect((await reconcileTraefik(pool, { dir, upstream: UP }, later)).removed).toEqual([fileNameFor("arjun.coach")]);
    await pool.query("update subscriptions set status = 'active' where user_id = $1", [arjun]);
    await reconcileTraefik(pool, { dir, upstream: UP }, later);
    await removeDomain(pool, arjun);
    expect((await reconcileTraefik(pool, { dir, upstream: UP }, later)).removed).toEqual([fileNameFor("arjun.coach")]);
    expect(await files()).toEqual(["coolify.yaml"]);
  });

  it("without TRAEFIK_DYNAMIC_DIR it still checks DNS but writes nothing", async () => {
    pointed = ["book.priya.in"];
    await setDomain(pool, priya, "book.priya.in");
    expect(await recheckDomains(pool, resolver, traefikFromEnv({}), new Date())).toEqual({ checked: 1, written: 0, removed: 0 });
    expect(await files()).toEqual(["coolify.yaml"]);
    await rm(dir, { recursive: true, force: true });
  });
});
