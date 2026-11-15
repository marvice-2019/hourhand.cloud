// Importing event types from Calendly and Cal.com, with an injected fetch serving recorded sample answers. The Postgres
// part runs only with TEST_DATABASE_URL (own database <name>_import).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createMemoryStore } from "../data/memory-store";
import { createPgStore } from "../data/pg-store";
import type { DataStore } from "../data/types";
import { createRateLimiter } from "../rate-limit";
import { fetchCalcom, CALCOM_API_VERSION } from "./calcom";
import { fetchCalendly } from "./calendly";
import { runImport, runPreview, type PreviewState } from "./index";
import { planImport, uniqueSlug } from "./plan";
import { CALCOM_LIST, CALENDLY_ME, CALENDLY_PAGE_1, CALENDLY_PAGE_2 } from "./samples";
import { PREVIEW_TTL_MS, openPreview, sealPreview } from "./sealed-preview";
import { ImportError, type FetchLike } from "./types";

const TOKEN = "eyJSECRET-calendly-token-1234567890";
const CAL_KEY = "cal_live_SECRETKEY0987654321";

type Call = { url: string; headers: Record<string, string> };

/** A fetch that answers from `routes` (first matching URL prefix) and records every request. */
function fakeFetch(routes: [string, number, unknown][], calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    const hit = routes.find(([prefix]) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const [, status, body] = hit;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const calendlyRoutes = (): [string, number, unknown][] => [
  ["https://api.calendly.com/users/me", 200, CALENDLY_ME],
  ["https://api.calendly.com/event_types?user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FAAAA&count=100&page_token=PAGE2", 200, CALENDLY_PAGE_2],
  ["https://api.calendly.com/event_types?user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FAAAA&count=100", 200, CALENDLY_PAGE_1],
];
const calcomRoutes = (): [string, number, unknown][] => [["https://api.cal.com/v2/event-types?username=priya", 200, CALCOM_LIST]];

describe("Calendly", () => {
  it("reads every page with the token in the header only, and skips team events", async () => {
    const calls: Call[] = [];
    const preview = await fetchCalendly(TOKEN, { fetch: fakeFetch(calendlyRoutes(), calls) });
    expect(calls.map((c) => c.url)).toHaveLength(3);
    expect(calls[2].url).toContain("page_token=PAGE2");
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
    expect(preview.eventTypes.map((e) => e.slug)).toEqual(["coaching", "workshop", "quick"]);
    expect(preview.skipped).toEqual([{ name: "Team demo", reason: expect.stringContaining("Team event") }]);
  });

  it("maps fields, buffers, start times, location and questions to Hourhand's nearest", async () => {
    const { eventTypes: [coaching] } = await fetchCalendly(TOKEN, { fetch: fakeFetch(calendlyRoutes()) });
    expect(coaching).toMatchObject({
      name: "Coaching", slug: "coaching", description: "Deep-dive coaching session.", durationMinutes: 45, durationOptions: [30, 45, 60],
      hidden: true, bufferBeforeMinutes: 10, bufferAfterMinutes: 15, startIncrementMinutes: 20, minNoticeMinutes: null, seatLimit: null,
      location: { kind: "in_person", value: "12 MG Road, Bengaluru" },
    });
    // Sorted by position, disabled ones dropped, a one-choice select becomes a short answer.
    expect(coaching.questions).toEqual([
      { label: "Company", kind: "short_text", required: false, choices: [] },
      { label: "What should we cover?", kind: "long_text", required: true, choices: [] },
      { label: "WhatsApp number", kind: "phone", required: false, choices: [] },
      { label: "How did you hear of us?", kind: "single_select", required: false, choices: ["Friend", "Instagram"] },
      { label: "Pick one", kind: "short_text", required: false, choices: [] },
    ]);
    expect(coaching.notes.join(" ")).toMatch(/only 45 minutes came over/);
    expect(coaching.notes.join(" ")).toMatch(/every 25 minutes became every 20/);
    expect(coaching.notes.join(" ")).toMatch(/Only the first location/);
    expect(coaching.notes.join(" ")).toMatch(/"Other" write-in/);
  });

  it("clamps lengths into 5 to 720 minutes and flags group events", async () => {
    const { eventTypes: [, workshop, quick] } = await fetchCalendly(TOKEN, { fetch: fakeFetch(calendlyRoutes()) });
    expect(workshop.durationMinutes).toBe(720);
    expect(workshop.notes.join(" ")).toMatch(/1440 to 720/);
    expect(workshop.notes.join(" ")).toMatch(/group event/);
    expect(workshop.notes.join(" ")).toMatch(/switched off in Calendly/);
    expect(quick.durationMinutes).toBe(5);
    expect(quick.location).toBeNull();
  });
});

describe("Cal.com", () => {
  it("asks for the username's types with the API version header and maps them", async () => {
    const calls: Call[] = [];
    const preview = await fetchCalcom(CAL_KEY, "priya", { fetch: fakeFetch(calcomRoutes(), calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${CAL_KEY}`, "cal-api-version": CALCOM_API_VERSION });
    expect(calls[0].url).not.toContain(CAL_KEY);
    expect(preview.skipped).toEqual([{ name: "Sales round robin", reason: expect.stringContaining("Team event") }]);

    const [strategy, yoga] = preview.eventTypes;
    expect(strategy).toMatchObject({
      sourceId: "101", slug: "strategy", durationMinutes: 60, minNoticeMinutes: 120, bufferBeforeMinutes: 5, bufferAfterMinutes: 240,
      seatLimit: null, hidden: false, location: { kind: "google_meet", value: null },
    });
    // Built-in fields (name, email, phone) and hidden ones are left out.
    expect(strategy.questions).toEqual([
      { label: "Agenda", kind: "long_text", required: true, choices: [] },
      { label: "Budget", kind: "single_select", required: false, choices: ["Under 1L", "1L to 5L"] },
      { label: "Topics", kind: "multi_select", required: false, choices: ["SEO", "Ads", "Brand"] },
      { label: "Team size", kind: "short_text", required: false, choices: [] },
    ]);
    expect(strategy.notes.join(" ")).toMatch(/"Topics" was a checkboxGroup question/);
    expect(strategy.notes.join(" ")).toMatch(/"Team size" was a number question/);
    expect(strategy.notes.join(" ")).toMatch(/Buffer after changed from 300 to 240/);
    expect(yoga).toMatchObject({ seatLimit: 20, hidden: true, location: { kind: "in_person", value: "Indiranagar studio" } });
  });

  it("says plainly when the username has no event types", async () => {
    const fetch = fakeFetch([["https://api.cal.com/v2/event-types", 200, { status: "success", data: [] }]]);
    await expect(fetchCalcom(CAL_KEY, "nobody", { fetch })).rejects.toMatchObject({ code: "not_found" });
    await expect(fetchCalcom(CAL_KEY, "bad name!", { fetch })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("provider errors", () => {
  it.each([[401, "bad_token"], [403, "bad_token"], [404, "not_found"], [429, "rate_limited"], [500, "unavailable"]])("%i -> %s, without the token", async (status, code) => {
    const fetch = fakeFetch([["https://", status, { message: `echo ${TOKEN}` }]]);
    for (const run of [() => fetchCalendly(TOKEN, { fetch }), () => fetchCalcom(TOKEN, "priya", { fetch })]) {
      const err = await run().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).code).toBe(code);
      expect((err as ImportError).message).not.toContain(TOKEN);
    }
  });

  it("times out after the limit and reports network failures", async () => {
    const hang: FetchLike = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    await expect(fetchCalendly(TOKEN, { fetch: hang, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    const down: FetchLike = async () => { throw new TypeError("fetch failed"); };
    await expect(fetchCalendly(TOKEN, { fetch: down })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("slugs and drafts", () => {
  it("adds -2, -3 on a clash and stays within 60 characters", () => {
    expect(uniqueSlug("coaching", "Coaching", new Set())).toBe("coaching");
    expect(uniqueSlug("coaching", "Coaching", new Set(["coaching"]))).toBe("coaching-2");
    expect(uniqueSlug("coaching", "Coaching", new Set(["coaching", "coaching-2"]))).toBe("coaching-3");
    const long = "a".repeat(60);
    expect(uniqueSlug(long, "x", new Set([long]))).toBe(`${"a".repeat(58)}-2`);
    expect(uniqueSlug("", "Café Chat!", new Set())).toBe("cafe-chat");
    expect(uniqueSlug("", "!!!", new Set())).toBe("event");
  });

  it("plans drafts through the editor's checks, avoiding clashes within the batch too", async () => {
    const { eventTypes } = await fetchCalendly(TOKEN, { fetch: fakeFetch(calendlyRoutes()) });
    const twice = [eventTypes[0], { ...eventTypes[0], sourceId: "again" }];
    const plans = planImport(twice, ["coaching"]);
    expect(plans.map((p) => p.ok && p.draft.slug)).toEqual(["coaching-2", "coaching-3"]);
    expect(plans[0].ok && plans[0].notes.join(" ")).toMatch(/link coaching was taken, so it is coaching-2/);
    expect(plans[0].ok && plans[0].draft).toMatchObject({ durationMinutes: 45, startIncrementMinutes: 20, minNoticeMinutes: 240, hidden: true, priceMinor: null });
  });
});

describe("the import flow", () => {
  let store: DataStore;
  let userId: string;
  const key = randomBytes(32);
  const now = Date.parse("2026-11-15T10:00:00Z");
  const deps = (fetch: FetchLike, log = vi.fn()) => ({ fetch, limiter: createRateLimiter(() => now), key, now, log });

  beforeEach(async () => {
    store = createMemoryStore();
    userId = (await store.getCurrentUser()).id;
  });

  it("previews, then imports only the ticked types, switched off, with their questions", async () => {
    const state = await runPreview(userId, { provider: "calendly", token: TOKEN, username: "" }, deps(fakeFetch(calendlyRoutes())));
    expect(state.status).toBe("preview");
    const preview = state as Extract<PreviewState, { status: "preview" }>;
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(preview.rows.map((r) => r.name)).toEqual(["Coaching", "Workshop", "Quick"]);

    const before = (await store.listEventTypes(userId)).length;
    const result = await runImport(store, userId, preview.sealed, ["https://api.calendly.com/event_types/A", "https://api.calendly.com/event_types/D"], { key, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.failed).toEqual([]);
    expect(result.outcome.created.map((c) => c.slug)).toEqual(["coaching-2", "quick"]);
    const all = await store.listEventTypes(userId);
    expect(all).toHaveLength(before + 2);
    for (const c of result.outcome.created) {
      const et = all.find((e) => e.id === c.id)!;
      expect(et.active).toBe(false);
    }
    const qs = await store.listCustomQuestions(userId, result.outcome.created[0].id);
    expect(qs.map((q) => q.kind)).toEqual(["short_text", "long_text", "phone", "single_select", "short_text"]);
    const loc = await store.listEventLocations(userId, result.outcome.created[0].id);
    expect(loc.map((l) => [l.kind, l.value])).toEqual([["in_person", "12 MG Road, Bengaluru"]]);
  });

  it("imports a Cal.com group class as a group with its seat limit", async () => {
    const state = await runPreview(userId, { provider: "calcom", token: CAL_KEY, username: "priya" }, deps(fakeFetch(calcomRoutes())));
    const preview = state as Extract<PreviewState, { status: "preview" }>;
    const result = await runImport(store, userId, preview.sealed, ["102"], { key, now });
    expect(result.ok && result.outcome.created).toHaveLength(1);
    const et = (await store.listEventTypes(userId)).find((e) => e.slug === "yoga")!;
    expect(et).toMatchObject({ kind: "group", seatLimit: 20, hidden: true, active: false, minNoticeMinutes: 0 });
  });

  it("refuses an expired, tampered or someone else's preview, and an empty selection", async () => {
    const preview = await fetchCalendly(TOKEN, { fetch: fakeFetch(calendlyRoutes()) });
    const sealed = sealPreview(key, userId, preview, now);
    expect(openPreview(key, userId, sealed, now + PREVIEW_TTL_MS)).toBeNull();
    expect(openPreview(key, "usr_other", sealed, now)).toBeNull();
    expect(openPreview(randomBytes(32), userId, sealed, now)).toBeNull();
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] ^= 1;
    expect(openPreview(key, userId, bytes.toString("base64url"), now)).toBeNull();
    expect(await runImport(store, userId, sealed, [], { key, now })).toEqual({ ok: false, error: expect.stringContaining("Tick at least one") });
    expect(await runImport(store, userId, sealed, ["https://api.calendly.com/event_types/A"], { key, now: now + PREVIEW_TTL_MS }))
      .toEqual({ ok: false, error: expect.stringContaining("expired") });
  });

  it("shows bad-token and username errors in plain words", async () => {
    const bad = await runPreview(userId, { provider: "calendly", token: TOKEN, username: "" }, deps(fakeFetch([["https://", 401, {}]])));
    expect(bad).toMatchObject({ status: "error", error: expect.stringContaining("didn't accept that token") });
    const noUser = await runPreview(userId, { provider: "calcom", token: CAL_KEY, username: "" }, deps(fakeFetch(calcomRoutes())));
    expect(noUser).toMatchObject({ status: "error", error: expect.stringContaining("username") });
    const missing = await runPreview(userId, { provider: "calcom", token: CAL_KEY, username: "ghost" }, deps(fakeFetch([["https://api.cal.com", 404, {}]])));
    expect(missing).toMatchObject({ status: "error", error: expect.stringContaining("couldn't find that username") });
    expect(JSON.stringify([bad, noUser, missing])).not.toContain(TOKEN);
  });

  it("limits fetches per host", async () => {
    const d = deps(fakeFetch(calendlyRoutes()));
    for (let i = 0; i < 10; i++) expect((await runPreview(userId, { provider: "calendly", token: TOKEN, username: "" }, d)).status).toBe("preview");
    expect(await runPreview(userId, { provider: "calendly", token: TOKEN, username: "" }, d)).toMatchObject({ status: "error", error: expect.stringContaining("Wait ten minutes") });
    // Another host is unaffected.
    expect((await runPreview("usr_other", { provider: "calendly", token: TOKEN, username: "" }, d)).status).toBe("preview");
  });

  it("never logs the token, even on an unexpected failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const log = vi.fn();
    const broken: FetchLike = async () => ({ ok: true, status: 200, json: async () => { throw new RangeError(`boom ${TOKEN}`); } });
    // A json() failure is a bad response; a throw past the mapper reaches the log.
    const weird: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ get resource(): unknown { throw new RangeError(`boom ${TOKEN}`); } }) });
    for (const fetch of [broken, weird, fakeFetch([["https://", 401, {}]])]) {
      const state = await runPreview(userId, { provider: "calendly", token: TOKEN, username: "" }, { ...deps(fetch, log) });
      expect(state.status).toBe("error");
      expect(JSON.stringify(state)).not.toContain(TOKEN);
    }
    expect(log).toHaveBeenCalledWith("Event type import failed", { provider: "calendly", error: "RangeError" });
    const logged = JSON.stringify([log.mock.calls, ...spies.map((s) => s.mock.calls)]);
    expect(logged).not.toContain(TOKEN);
    spies.forEach((s) => s.mockRestore());
  });
});

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("import into Postgres", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let userId: string;
  const key = randomBytes(32);
  const now = Date.parse("2026-11-15T10:00:00Z");

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_import`;
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
    store = createPgStore(pool);
    userId = (await store.getUserBySlug("priya"))!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("saves switched-off event types with unique slugs, and the token is nowhere in the database", async () => {
    const limiter = createRateLimiter(() => now);
    const fetch = fakeFetch([...calendlyRoutes(), ...calcomRoutes()]);
    const a = await runPreview(userId, { provider: "calendly", token: TOKEN, username: "" }, { fetch, limiter, key, now });
    const b = await runPreview(userId, { provider: "calcom", token: CAL_KEY, username: "priya" }, { fetch, limiter, key, now });
    const ra = await runImport(store, userId, (a as Extract<PreviewState, { status: "preview" }>).sealed, ["https://api.calendly.com/event_types/A", "https://api.calendly.com/event_types/C"], { key, now });
    const rb = await runImport(store, userId, (b as Extract<PreviewState, { status: "preview" }>).sealed, ["101", "102"], { key, now });
    // Importing the same Calendly type again gets the next free link.
    const again = await runImport(store, userId, (a as Extract<PreviewState, { status: "preview" }>).sealed, ["https://api.calendly.com/event_types/A"], { key, now });
    expect(ra.ok && ra.outcome.created.map((c) => c.slug)).toEqual(["coaching-2", "workshop"]);
    expect(rb.ok && rb.outcome.created.map((c) => c.slug)).toEqual(["strategy", "yoga"]);
    expect(again.ok && again.outcome.created.map((c) => c.slug)).toEqual(["coaching-3"]);

    const { rows } = await pool.query("select slug, active, kind, seat_limit from event_types where user_id = $1 and slug in ('coaching-2','workshop','strategy','yoga','coaching-3') order by slug", [userId]);
    expect(rows).toEqual([
      { slug: "coaching-2", active: false, kind: "one_on_one", seat_limit: null },
      { slug: "coaching-3", active: false, kind: "one_on_one", seat_limit: null },
      { slug: "strategy", active: false, kind: "one_on_one", seat_limit: null },
      { slug: "workshop", active: false, kind: "one_on_one", seat_limit: null },
      { slug: "yoga", active: false, kind: "group", seat_limit: 20 },
    ]);

    // Every row of every table, as text: neither secret appears anywhere.
    const tables = await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
    for (const { table_name } of tables.rows as { table_name: string }[]) {
      const dump = await pool.query(`select t::text as row from "${table_name}" t`);
      const text = dump.rows.map((r: { row: string }) => r.row).join("\n");
      expect(text, table_name).not.toContain(TOKEN);
      expect(text, table_name).not.toContain(CAL_KEY);
    }
  });
});
