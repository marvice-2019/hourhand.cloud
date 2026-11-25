// Routing forms. The rules are plain unit tests; everything that touches the database runs only with TEST_DATABASE_URL,
// against its own database <name>_routing, dropped and recreated on every run.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { createPgStore } from "../data/pg-store";
import type { EventType, User } from "../data/types";
import { HOST_CATALOGS, type HostKey } from "../i18n/host";
import {
  checkRoutingForm, createRoutingForm, deleteRoutingForm, listRoutingForms, routableEventTypes, ROUTING_LIMITS, ROUTING_MESSAGES,
  routingFormByToken, routingFormForHost, updateRoutingForm, type RoutingFormInput,
} from "./routing";

const UUID_A = "00000000-0000-4000-8000-00000000000a";
const form = (over: Partial<RoutingFormInput> = {}): RoutingFormInput => ({
  title: "Book a session", question: "Is this your first session?", active: true,
  options: [{ label: "Yes, first time", eventTypeId: UUID_A, message: null }, { label: "No", eventTypeId: null, message: "Email me first." }],
  ...over,
});
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
};

describe("checkRoutingForm", () => {
  it("tidies the words and drops empty rows, even when their picker shows a booking type", () => {
    const out = checkRoutingForm(form({
      title: "  Book   a session ", options: [...form().options, { label: " ", eventTypeId: UUID_A, message: null }, { label: "", eventTypeId: null, message: null }],
    }));
    expect(out.title).toBe("Book a session");
    expect(out.options).toHaveLength(2);
  });

  it("asks for a booking type or a note on each answer, never both or neither", () => {
    expect(thrown(() => checkRoutingForm(form({ options: [{ label: "A", eventTypeId: UUID_A, message: "x" }, form().options[1]] })))).toBe(ROUTING_MESSAGES.optionTarget);
    expect(thrown(() => checkRoutingForm(form({ options: [{ label: "A", eventTypeId: null, message: null }, form().options[1]] })))).toBe(ROUTING_MESSAGES.optionTarget);
  });

  it("needs 2 to 8 answers, a heading, a question and short labels and notes", () => {
    expect(thrown(() => checkRoutingForm(form({ options: [form().options[0]] })))).toBe(ROUTING_MESSAGES.optionCount);
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `A${i}`, eventTypeId: null, message: "x" }));
    expect(thrown(() => checkRoutingForm(form({ options: nine })))).toBe(ROUTING_MESSAGES.optionCount);
    expect(thrown(() => checkRoutingForm(form({ title: " " })))).toBe(ROUTING_MESSAGES.title);
    expect(thrown(() => checkRoutingForm(form({ question: "q".repeat(201) })))).toBe(ROUTING_MESSAGES.question);
    expect(thrown(() => checkRoutingForm(form({ options: [{ label: "l".repeat(81), eventTypeId: UUID_A, message: null }, form().options[1]] })))).toBe(ROUTING_MESSAGES.optionLabel);
    expect(thrown(() => checkRoutingForm(form({ options: [form().options[0], { label: "B", eventTypeId: null, message: "m".repeat(301) }] })))).toBe(ROUTING_MESSAGES.optionMessage);
    expect(thrown(() => checkRoutingForm(form({ options: [{ label: "A", eventTypeId: "not-an-id", message: null }, form().options[1]] })))).toBe(ROUTING_MESSAGES.eventType);
  });

  it("has a host line with the same English for every error", () => {
    for (const [code, english] of Object.entries(ROUTING_MESSAGES)) {
      const key = `routing.err${code[0].toUpperCase()}${code.slice(1)}` as HostKey;
      expect(HOST_CATALOGS.en[key], code).toBe(english);
    }
  });
});

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("routing forms (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let priya: User;
  let arun: User;
  let coaching: EventType;
  let arunChat: EventType;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_routing`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(`drop database if exists ${name} with (force)`);
      await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    await migrate(u.toString());
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    const store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
    coaching = (await store.listEventTypes(priya.id)).find((e) => e.slug === "coaching")!;
    arunChat = (await store.listEventTypes(arun.id)).find((e) => e.slug === "chat")!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const priyaForm = (over: Partial<RoutingFormInput> = {}) =>
    form({ options: [{ label: "First session", eventTypeId: coaching.id, message: null }, { label: "Something else", eventTypeId: null, message: "Email me first." }], ...over });

  it("creates a form whose link sends each answer to the host's booking page or shows the note", async () => {
    const { id, token } = await createRoutingForm(pool, priya.id, priyaForm());
    const page = await routingFormByToken(pool, token);
    expect(page).toMatchObject({ title: "Book a session", question: "Is this your first session?" });
    expect(page!.options).toEqual([
      { position: 1, label: "First session", href: "/priya/coaching", message: null },
      { position: 2, label: "Something else", href: null, message: "Email me first." },
    ]);
    expect((await routingFormForHost(pool, priya.id, id))!.options).toHaveLength(2);
    expect(await routingFormForHost(pool, arun.id, id)).toBeNull();
  });

  it("refuses another host's booking type", async () => {
    await expect(createRoutingForm(pool, priya.id, priyaForm({ options: [{ label: "Chat", eventTypeId: arunChat.id, message: null }, priyaForm().options[1]] })))
      .rejects.toThrow(ROUTING_MESSAGES.eventType);
  });

  it("leaves out an answer whose booking type was switched off, and hides a form that is off", async () => {
    const extra = (await pool.query(
      `insert into event_types (user_id, name, slug, duration_minutes) values ($1, 'Intro', 'intro-routing', 20) returning id`, [priya.id])).rows[0].id as string;
    const { id, token } = await createRoutingForm(pool, priya.id, priyaForm({ options: [{ label: "Intro", eventTypeId: extra, message: null }, ...priyaForm().options] }));
    expect((await routingFormByToken(pool, token))!.options.map((o) => o.label)).toEqual(["Intro", "First session", "Something else"]);
    await pool.query("update event_types set active = false where id = $1", [extra]);
    expect((await routingFormByToken(pool, token))!.options.map((o) => o.label)).toEqual(["First session", "Something else"]);
    expect((await routableEventTypes(pool, priya.id)).some((e) => e.id === extra)).toBe(false);
    await pool.query("delete from event_types where id = $1", [extra]);
    expect((await routingFormByToken(pool, token))!.options.map((o) => o.label)).toEqual(["First session", "Something else"]);
    await updateRoutingForm(pool, priya.id, id, { ...priyaForm(), active: false });
    expect(await routingFormByToken(pool, token)).toBeNull();
  });

  it("only lets the owner change or delete a form", async () => {
    const { id, token } = await createRoutingForm(pool, priya.id, priyaForm());
    await expect(updateRoutingForm(pool, arun.id, id, priyaForm({ title: "Hijacked" }))).rejects.toThrow();
    await expect(deleteRoutingForm(pool, arun.id, id)).rejects.toThrow();
    expect((await routingFormByToken(pool, token))!.title).toBe("Book a session");
    await updateRoutingForm(pool, priya.id, id, priyaForm({ title: "Start here" }));
    expect((await routingFormByToken(pool, token))!.title).toBe("Start here");
    await deleteRoutingForm(pool, priya.id, id);
    expect(await routingFormByToken(pool, token)).toBeNull();
  });

  it("stops at the form limit", async () => {
    const have = (await listRoutingForms(pool, arun.id)).length;
    const arunForm = form({ options: [{ label: "Chat", eventTypeId: arunChat.id, message: null }, { label: "Other", eventTypeId: null, message: "Email me." }] });
    for (let i = have; i < ROUTING_LIMITS.maxForms; i++) await createRoutingForm(pool, arun.id, arunForm);
    await expect(createRoutingForm(pool, arun.id, arunForm)).rejects.toThrow(ROUTING_MESSAGES.limit);
  });

  it("doesn't open a link that isn't a token", async () => {
    expect(await routingFormByToken(pool, "../../etc")).toBeNull();
  });
});
