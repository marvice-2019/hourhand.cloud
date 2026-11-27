// B17: super admins approve, decline and suspend hosts; a host who isn't approved has no public pages and takes no
// new bookings, but can still sign in. Real Postgres only (TEST_DATABASE_URL; its own database <name>_rev).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { handleGetSlots } from "../booking";
import { createPgStore } from "../data/pg-store";
import { listAudit, type Actor } from "./roles";
import { actionsFor, countPending, getRequireApproval, markForReviewIfRequired, reviewStatusOf, setHostReview, setRequireApproval } from "./review";
import { listHosts } from "./queries";

const BASE = process.env.TEST_DATABASE_URL;

describe("review moves", () => {
  it("offers only the moves that make sense from each status", () => {
    expect(actionsFor("pending")).toEqual(["approve", "decline"]);
    expect(actionsFor("approved")).toEqual(["suspend"]);
    expect(actionsFor("declined")).toEqual(["approve"]);
    expect(actionsFor("suspended")).toEqual(["reactivate"]);
  });
});

describe.skipIf(!BASE)("host review (Postgres)", () => {
  let pool: pg.Pool;
  let owner: Actor;
  let admin: Actor;
  let priyaId: string;
  const now = new Date();

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_rev`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const root = new URL(BASE!);
    root.pathname = "/postgres";
    const c = new pg.Client({ connectionString: root.toString() });
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
    const make = async (email: string, slug: string) =>
      (await pool.query("insert into users (email, name, slug) values ($1, $2, $3) returning id, email", [email, email.split("@")[0], slug])).rows[0];
    const o = await make("owner@hourhand.test", "owner-rev");
    const a = await make("support@hourhand.test", "support-rev");
    owner = { id: o.id, email: o.email, role: "super_admin" };
    admin = { id: a.id, email: a.email, role: "admin" };
    priyaId = (await pool.query("select id from users where slug = 'priya'")).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const slotsFor = async (params: Record<string, string>) => {
    const from = new Date(now.getTime() + 2 * 86_400_000), to = new Date(now.getTime() + 30 * 86_400_000);
    return handleGetSlots(createPgStore(pool), new URLSearchParams({ ...params, from: from.toISOString(), to: to.toISOString() }), now);
  };

  it("every host made before review existed is approved, and the seeded page takes bookings", async () => {
    expect(await reviewStatusOf(pool, priyaId)).toBe("approved");
    const res = await slotsFor({ slug: "priya", event: "coaching" });
    expect(res.status).toBe(200);
    expect((res.body as { slots: string[] }).slots.length).toBeGreaterThan(0);
  });

  it("a suspended host's page and single-use links are gone, their own sign-in still works, and reactivating restores them", async () => {
    const store = createPgStore(pool);
    const et = (await store.getPublicEventType("priya", "coaching"))!.eventType;
    const { token } = await store.createBookingLink(priyaId, et.id, { label: "Review test" }, now);
    expect(await setHostReview(pool, owner, priyaId, "suspend", now)).toBe("suspended");

    expect(await store.getUserBySlug("priya")).toBeNull();
    expect(await store.getPublicEventType("priya", "coaching")).toBeNull();
    expect((await slotsFor({ slug: "priya", event: "coaching" })).status).toBe(404);
    expect((await store.resolveBookingLink(token, now)).status).toBe("not_found");
    expect((await slotsFor({ link: token })).status).toBe(404);
    // The host's own session reads the account by id, which a suspension doesn't hide.
    expect((await store.getUser(priyaId))?.slug).toBe("priya");

    expect(await setHostReview(pool, owner, priyaId, "reactivate", now)).toBe("approved");
    expect((await store.getUserBySlug("priya"))?.id).toBe(priyaId);
    expect((await store.resolveBookingLink(token, now)).status).toBe("open");
  });

  it("refuses moves that don't fit the status, staff without the permission, their own account and a closed one", async () => {
    await expect(setHostReview(pool, owner, priyaId, "approve")).rejects.toMatchObject({ reason: "bad_transition" });
    await expect(setHostReview(pool, owner, priyaId, "delete")).rejects.toMatchObject({ reason: "bad_action" });
    await expect(setHostReview(pool, admin, priyaId, "suspend")).rejects.toMatchObject({ reason: "not_allowed" });
    await expect(setHostReview(pool, owner, owner.id, "suspend")).rejects.toMatchObject({ reason: "self" });
    await expect(setHostReview(pool, owner, "00000000-0000-4000-8000-000000000000", "suspend")).rejects.toMatchObject({ reason: "no_account" });
    const closed = (await pool.query("insert into users (email, slug, deleted_at) values ('gone@example.in', 'gone-rev', now()) returning id")).rows[0].id;
    await expect(setHostReview(pool, owner, closed, "suspend")).rejects.toMatchObject({ reason: "closed" });
    expect(await reviewStatusOf(pool, priyaId)).toBe("approved");
  });

  it("with approval required, a new sign-up waits; approve and decline move it, and every step is logged", async () => {
    await expect(setRequireApproval(pool, admin, true)).rejects.toMatchObject({ reason: "not_allowed" });
    const newcomer = async (email: string, slug: string) => {
      const id = (await pool.query("insert into users (email, slug) values ($1, $2) returning id", [email, slug])).rows[0].id as string;
      await markForReviewIfRequired(pool, id);
      return id;
    };
    // Off by default: new hosts go live straight away.
    expect(await getRequireApproval(pool)).toBe(false);
    expect(await reviewStatusOf(pool, await newcomer("early@example.in", "early-rev"))).toBe("approved");

    await setRequireApproval(pool, owner, true);
    expect(await getRequireApproval(pool)).toBe(true);
    const a = await newcomer("anu@example.in", "anu-rev");
    const b = await newcomer("bala@example.in", "bala-rev");
    expect(await reviewStatusOf(pool, a)).toBe("pending");
    expect(await countPending(pool)).toBe(2);
    expect((await listHosts(pool, { review: "pending" })).hosts.map((h) => h.id).sort()).toEqual([a, b].sort());
    expect(await createPgStore(pool).getUserBySlug("anu-rev")).toBeNull();

    expect(await setHostReview(pool, owner, a, "approve")).toBe("approved");
    expect(await setHostReview(pool, owner, b, "decline")).toBe("declined");
    expect((await createPgStore(pool).getUserBySlug("anu-rev"))?.id).toBe(a);
    expect(await countPending(pool)).toBe(0);
    // A declined host can still be approved later.
    expect(await setHostReview(pool, owner, b, "approve")).toBe("approved");
    // Switching it off again doesn't touch a reviewed host.
    await setRequireApproval(pool, owner, false);
    await markForReviewIfRequired(pool, b);
    expect(await reviewStatusOf(pool, b)).toBe("approved");

    const actions = (await listAudit(pool)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["host.suspend", "host.reactivate", "host.approve", "host.decline", "settings.require_approval.on", "settings.require_approval.off"]));
  });
});
