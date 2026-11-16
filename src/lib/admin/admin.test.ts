// Hourhand staff roles, the audit log and the read-only host views. The role checks run always; the rest against
// real Postgres (only with TEST_DATABASE_URL; uses its own database <name>_adm, dropped and recreated each run).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { hostDetail, listHosts, overview } from "./queries";
import { can, envSuperAdmins, grantRole, listAudit, listStaff, revokeRole, staffRole, type Actor } from "./roles";

const BASE = process.env.TEST_DATABASE_URL;

describe("staff permissions", () => {
  it("admins read; only super admins manage staff and read the audit log; everyone else nothing", () => {
    expect(can("admin", "view_overview")).toBe(true);
    expect(can("admin", "view_hosts")).toBe(true);
    expect(can("admin", "manage_staff")).toBe(false);
    expect(can("admin", "view_audit")).toBe(false);
    expect(can("super_admin", "manage_staff")).toBe(true);
    expect(can("super_admin", "view_audit")).toBe(true);
    expect(can(null, "view_overview")).toBe(false);
  });

  it("reads SUPER_ADMIN_EMAILS loosely: spaces, case, and junk dropped", () => {
    expect([...envSuperAdmins({ SUPER_ADMIN_EMAILS: " Owner@Marvice.in , not-an-email,ops@example.in" })]).toEqual(["owner@marvice.in", "ops@example.in"]);
    expect(envSuperAdmins({}).size).toBe(0);
  });
});

describe.skipIf(!BASE)("staff and admin views (Postgres)", () => {
  let pool: pg.Pool;
  const env = { SUPER_ADMIN_EMAILS: "owner@hourhand.test" };
  const ids: Record<string, string> = {};

  async function user(email: string, name: string, slug: string): Promise<string> {
    const { rows: [u] } = await pool.query("insert into users (email, name, slug) values ($1, $2, $3) returning id", [email, name, slug]);
    return u.id;
  }
  const actor = async (key: string): Promise<Actor> => {
    const { rows: [u] } = await pool.query("select id, email from users where id = $1", [ids[key]]);
    return { id: u.id, email: u.email, role: await staffRole(pool, u, env) };
  };

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_adm`;
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
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    ids.owner = await user("owner@hourhand.test", "Owner", "owner-hh");
    ids.support = await user("support@hourhand.test", "Support", "support-hh");
    ids.host = await user("host_100%@example.in", "Meera Coach", "meera-coach");
    ids.other = await user("other@example.in", "Other Host", "other-host");
    await pool.query(
      "insert into integrations (user_id, provider, credentials_encrypted, public_id, mode, status) values ($1, 'razorpay', '\\xdeadbeef', 'rzp_test_abcdefgh12', 'test', 'ok')", [ids.host]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("an account's role: super admin from the environment, otherwise from staff_roles, otherwise none", async () => {
    expect((await actor("owner")).role).toBe("super_admin");
    expect((await actor("host")).role).toBeNull();
    // The environment list matches case-insensitively, and a closed account loses its role.
    expect(await staffRole(pool, { id: ids.owner, email: "OWNER@hourhand.test" }, env)).toBe("super_admin");
    await pool.query("update users set deleted_at = now() where id = $1", [ids.other]);
    expect(await staffRole(pool, { id: ids.other, email: "other@example.in" }, { SUPER_ADMIN_EMAILS: "other@example.in" })).toBeNull();
    await pool.query("update users set deleted_at = null where id = $1", [ids.other]);
  });

  it("only a super admin adds staff, to an existing account, never themselves or a server-set super admin", async () => {
    const owner = await actor("owner");
    await expect(grantRole(pool, owner, "nobody@example.in", "admin", env)).rejects.toMatchObject({ reason: "no_account" });
    await expect(grantRole(pool, owner, "owner@hourhand.test", "admin", env)).rejects.toMatchObject({ reason: "fixed_by_env" });
    await expect(grantRole(pool, owner, "support@hourhand.test", "root", env)).rejects.toMatchObject({ reason: "bad_role" });
    const s = await grantRole(pool, owner, " Support@Hourhand.test ", "admin", env);
    expect(s).toMatchObject({ userId: ids.support, role: "admin" });
    const support = await actor("support");
    expect(support.role).toBe("admin");
    // An admin can't add or remove anyone, including making themselves a super admin.
    await expect(grantRole(pool, support, "support@hourhand.test", "super_admin", env)).rejects.toMatchObject({ reason: "not_allowed" });
    await expect(grantRole(pool, support, "host_100%@example.in", "admin", env)).rejects.toMatchObject({ reason: "not_allowed" });
    await expect(revokeRole(pool, support, ids.owner, env)).rejects.toMatchObject({ reason: "not_allowed" });
    // A granted super admin can't change their own role either.
    await grantRole(pool, owner, "support@hourhand.test", "super_admin", env);
    const promoted = await actor("support");
    expect(promoted.role).toBe("super_admin");
    await expect(grantRole(pool, promoted, "support@hourhand.test", "admin", env)).rejects.toMatchObject({ reason: "self" });
    await expect(revokeRole(pool, promoted, ids.support, env)).rejects.toMatchObject({ reason: "self" });
    await expect(revokeRole(pool, promoted, ids.owner, env)).rejects.toMatchObject({ reason: "fixed_by_env" });
  });

  it("lists staff, removes them, and logs every change", async () => {
    const owner = await actor("owner");
    const staff = await listStaff(pool, env);
    expect(staff.map((s) => [s.email, s.role, s.fromEnv])).toEqual([["owner@hourhand.test", "super_admin", true], ["support@hourhand.test", "super_admin", false]]);
    await revokeRole(pool, owner, ids.support, env);
    expect((await actor("support")).role).toBeNull();
    expect((await listStaff(pool, env)).map((s) => s.email)).toEqual(["owner@hourhand.test"]);
    const log = await listAudit(pool);
    expect(log.map((e) => [e.actorEmail, e.action, e.detail.role])).toEqual([
      ["owner@hourhand.test", "staff.revoke", "super_admin"],
      ["owner@hourhand.test", "staff.grant", "super_admin"],
      ["owner@hourhand.test", "staff.grant", "admin"],
    ]);
    expect(log.every((e) => e.targetId === ids.support)).toBe(true);
  });

  it("finds hosts by name, email or page address, taking % and _ literally", async () => {
    expect((await listHosts(pool, { q: "meera" })).hosts.map((h) => h.id)).toEqual([ids.host]);
    expect((await listHosts(pool, { q: "OTHER-HOST" })).hosts.map((h) => h.id)).toEqual([ids.other]);
    expect((await listHosts(pool, { q: "100%" })).hosts.map((h) => h.id)).toEqual([ids.host]);
    expect((await listHosts(pool, { q: "%" })).total).toBe(1); // only the address that has a real %
    const all = await listHosts(pool);
    expect(all.total).toBeGreaterThanOrEqual(5);
    expect(all.hosts.find((h) => h.id === ids.host)).toMatchObject({ razorpay: true, plan: "free" });
  });

  it("a host's details carry provider and status, never credentials, and nothing about their clients", async () => {
    const d = (await hostDetail(pool, ids.host, new Date()))!;
    expect(d.connections).toEqual([{ provider: "razorpay", status: "ok" }]);
    const text = JSON.stringify(d);
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("rzp_test_abcdefgh12");
    expect(d.counts).toEqual({ eventTypes: 0, bookings: 0, upcoming: 0, packagesSold: 0, activeMembers: 0, invoices: 0 });
    expect(await hostDetail(pool, "6f1c2d3e-0000-4000-8000-000000000001", new Date())).toBeNull();
    expect(await hostDetail(pool, "not-a-uuid", new Date())).toBeNull();
    // The seeded demo host has bookings; the counts see them without listing anyone.
    const { rows: [priya] } = await pool.query("select id from users where slug = 'priya'");
    const p = (await hostDetail(pool, priya.id, new Date()))!;
    expect(p.counts.bookings).toBeGreaterThan(0);
    expect(Object.keys(p)).not.toContain("bookings");
  });

  it("the overview adds up across hosts", async () => {
    const o = await overview(pool, new Date());
    expect(o.hosts).toBe((await listHosts(pool)).total);
    expect(o).toMatchObject({ closedHosts: 0, activeMemberships: 0 });
  });
});
