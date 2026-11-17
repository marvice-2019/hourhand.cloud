// POST /api/bookings with onBehalf: the account comes from the session (getHostContext), never from the request body.
// Runs the real route and booking handler on the in-memory store; only the session and payments are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../data/memory-store";
import { buildSeed } from "../data/seed";
import type { CreateBookingInput } from "../data/types";

const now = new Date();
const store = createMemoryStore(buildSeed(now));
const inputs: CreateBookingInput[] = [];
const createBooking = store.createBooking.bind(store);
store.createBooking = async (input) => { inputs.push(input); return createBooking(input); };
const session = { ctx: null as null | { host: { id: string }; actor: { id: string }; acting: boolean } };

vi.mock("@/lib/data", () => ({ store }));
vi.mock("@/lib/auth/session", () => ({ getHostContext: async () => session.ctx }));
vi.mock("@/lib/payments/request-deps", () => ({ requestPaymentDeps: () => null }));

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/bookings/route");
  const req = new Request("http://localhost/api/bookings", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" } });
  const res = await POST(req as never);
  return { status: res.status, body: await res.json() };
}

describe("booking for a client through the API", () => {
  let n = 0;
  let body: () => Promise<Record<string, unknown>>;
  let hostId: string;
  beforeEach(async () => {
    inputs.length = 0;
    const host = (await store.getUserBySlug("priya"))!;
    hostId = host.id;
    const coaching = (await store.listEventTypes(host.id)).find((e) => e.slug === "coaching")!;
    const questions = await store.listCustomQuestions(host.id, coaching.id);
    const answers = Object.fromEntries(questions.filter((q) => q.required).map((q) => [q.id, "Something"]));
    body = async () => {
      const { handleGetSlots } = await import("../booking");
      const params = new URLSearchParams({ slug: "priya", event: "coaching", from: now.toISOString(), to: new Date(now.getTime() + 30 * 86_400_000).toISOString(), tz: "Asia/Kolkata" });
      const slots = ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots;
      return { slug: "priya", event: "coaching", start: slots[n], name: "Meera Iyer", email: `meera${n}@example.com`, timezone: "Asia/Kolkata", answers, idempotencyKey: `route-behalf-${++n}-xxxx`, onBehalf: true };
    };
  });

  it("refuses a signed-out request and one signed in to another account", async () => {
    session.ctx = null;
    expect(await post(await body())).toEqual({ status: 403, body: { error: "not_your_booking_page" } });
    // Naming the host in the body changes nothing: the account only ever comes from the session.
    expect((await post({ ...(await body()), hostId, actor: { hostId } })).status).toBe(403);
    session.ctx = { host: { id: "11111111-1111-4111-8111-111111111111" }, actor: { id: "11111111-1111-4111-8111-111111111111" }, acting: false };
    expect((await post(await body())).status).toBe(403);
    expect(inputs).toEqual([]);
  });

  it("books for the owner and for their Duo second person acting on the account, logged as host_on_behalf", async () => {
    session.ctx = { host: { id: hostId }, actor: { id: hostId }, acting: false };
    expect((await post(await body())).status).toBe(201);
    session.ctx = { host: { id: hostId }, actor: { id: "22222222-2222-4222-8222-222222222222" }, acting: true };
    expect((await post(await body())).status).toBe(201);
    expect(inputs.map((i) => i.invitee.consent![0].channel)).toEqual(["host_on_behalf", "host_on_behalf"]);
  });

  it("leaves an ordinary guest booking as booking_page without looking at the session", async () => {
    session.ctx = null;
    const guest = { ...(await body()), onBehalf: undefined };
    expect((await post(guest)).status).toBe(201);
    expect(inputs[0].invitee.consent![0].channel).toBe("booking_page");
  });
});
