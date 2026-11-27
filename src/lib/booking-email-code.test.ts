// B11: a guest proves their email with a code before an event type that asks for it is booked.
import { describe, expect, it } from "vitest";
import { handleCreateBooking, handleGetSlots, type EmailCodeDeps } from "./booking";
import { createMemoryStore } from "./data/memory-store";
import { buildSeed } from "./data/seed";
import { createRateLimiter } from "./rate-limit";

const now = new Date("2026-10-10T04:00:00Z");
const DAY = 86_400_000;
// Bookings the demo seed starts with.
const seeded = buildSeed(now).bookings.length;
const later = (ms: number) => new Date(now.getTime() + ms);

function setup(verify = true) {
  const seed = buildSeed(now);
  seed.eventTypes.find((e) => e.id === "evt_coaching")!.verifyGuestEmail = verify;
  const store = createMemoryStore(seed);
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  const codes: EmailCodeDeps = { secret: "test-key", send: async (m) => { sent.push(m); } };
  const lastCode = () => sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? null;
  return { store, sent, codes, lastCode };
}

async function slots(store: ReturnType<typeof createMemoryStore>): Promise<string[]> {
  const params = new URLSearchParams({ slug: "priya", event: "coaching", from: now.toISOString(), to: later(14 * DAY).toISOString(), tz: "Asia/Kolkata" });
  return ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots;
}

const request = (start: string, extra: Record<string, unknown> = {}) => ({
  slug: "priya", event: "coaching", start, name: "Meera Iyer", email: "Meera@Example.com", timezone: "Asia/Kolkata", locale: "ta",
  answers: { q_goal: "Planning a career move." }, idempotencyKey: "key-code-0001", ...extra,
});

describe("checking the guest's email before booking (B11)", () => {
  it("books at once when the event type doesn't ask", async () => {
    const { store, sent, codes } = setup(false);
    const [start] = await slots(store);
    expect((await handleCreateBooking(store, request(start), now, undefined, null, undefined, null, codes)).status).toBe(201);
    expect(sent).toHaveLength(0);
  });

  it("emails a code instead of booking, then books with the right code, once", async () => {
    const { store, sent, codes, lastCode } = setup();
    const [start] = await slots(store);
    const first = await handleCreateBooking(store, request(start), now, undefined, null, undefined, null, codes);
    expect(first).toEqual({ status: 202, body: { verification: "email_code_sent" } });
    expect(await store.listBookings("usr_priya")).toHaveLength(seeded);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("Meera@Example.com");
    // In the language the guest is booking in (Tamil here), naming the event and host.
    expect(sent[0].subject).toContain(lastCode()!);
    expect(sent[0].text).toMatch(/குறியீடு/);
    expect(sent[0].text).toContain("Priya");

    const booked = await handleCreateBooking(store, request(start, { emailCode: lastCode() }), later(60_000), undefined, null, undefined, null, codes);
    expect(booked.status).toBe(201);
    // The same code can't make a second booking.
    const again = await handleCreateBooking(store, request(start, { emailCode: lastCode(), idempotencyKey: "key-code-0002" }), later(70_000), undefined, null, undefined, null, codes);
    expect(again.status).not.toBe(201);
    expect(await store.listBookings("usr_priya")).toHaveLength(seeded + 1);
  });

  it("refuses a wrong code and ends the code after 5 wrong tries", async () => {
    const { store, codes, lastCode } = setup();
    const [start] = await slots(store);
    await handleCreateBooking(store, request(start), now, undefined, null, undefined, null, codes);
    const right = lastCode()!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await handleCreateBooking(store, request(start, { emailCode: wrong }), later(1000), undefined, null, undefined, null, codes);
      expect(res).toMatchObject({ status: 400, body: { fields: { emailCode: expect.any(String) } } });
    }
    expect(await handleCreateBooking(store, request(start, { emailCode: right }), later(2000), undefined, null, undefined, null, codes))
      .toEqual({ status: 400, body: { error: "code_expired" } });
    expect(await store.listBookings("usr_priya")).toHaveLength(seeded);
  });

  it("refuses an expired code, and a code that isn't 6 digits", async () => {
    const { store, codes, lastCode } = setup();
    const [start] = await slots(store);
    await handleCreateBooking(store, request(start), now, undefined, null, undefined, null, codes);
    expect(await handleCreateBooking(store, request(start, { emailCode: lastCode() }), later(10 * 60_000), undefined, null, undefined, null, codes))
      .toEqual({ status: 400, body: { error: "code_expired" } });
    expect(await handleCreateBooking(store, request(start, { emailCode: "12ab" }), now, undefined, null, undefined, null, codes))
      .toMatchObject({ status: 400, body: { fields: { emailCode: expect.any(String) } } });
  });

  it("sends a new code at most once a minute", async () => {
    const { store, sent, codes } = setup();
    const [start] = await slots(store);
    await handleCreateBooking(store, request(start), now, undefined, null, undefined, null, codes);
    expect(await handleCreateBooking(store, request(start), later(30_000), undefined, null, undefined, null, codes))
      .toEqual({ status: 429, body: { error: "code_rate_limited", reason: "too_soon" } });
    expect((await handleCreateBooking(store, request(start), later(61_000), undefined, null, undefined, null, codes)).status).toBe(202);
    expect(sent).toHaveLength(2);
  });

  it("doesn't charge the booking limits for a submit with a code", async () => {
    const { store, codes, lastCode } = setup();
    const [start] = await slots(store);
    const limit = { clientKey: "1.2.3.4", limiter: createRateLimiter() };
    await handleCreateBooking(store, request(start), now, limit, null, undefined, null, codes);
    const code = lastCode()!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await handleCreateBooking(store, request(start, { emailCode: wrong }), later(1000), limit, null, undefined, null, codes);
    expect((await handleCreateBooking(store, request(start, { emailCode: code }), later(2000), limit, null, undefined, null, codes)).status).toBe(201);
  });

  it("says it can't send when the mail fails or there's no mailer", async () => {
    const { store } = setup();
    const [start] = await slots(store);
    const failing: EmailCodeDeps = { secret: "k", send: async () => { throw new Error("Resend 503"); } };
    expect(await handleCreateBooking(store, request(start), now, undefined, null, undefined, null, failing)).toEqual({ status: 502, body: { error: "code_send_failed" } });
    expect(await handleCreateBooking(store, request(start, { idempotencyKey: "key-code-0003" }), later(61_000), undefined, null, undefined, null, null))
      .toEqual({ status: 502, body: { error: "code_send_failed" } });
    expect(await store.listBookings("usr_priya")).toHaveLength(seeded);
  });

  it("skips the check for the host's own booking for a client and for a single-use link", async () => {
    const { store, sent, codes } = setup();
    const all = await slots(store);
    const [first, second] = [all[0], all.at(-1)!];
    const behalf = await handleCreateBooking(store, { ...request(first), onBehalf: true }, now, undefined, null, undefined, { hostId: "usr_priya" }, codes);
    expect(behalf.status).toBe(201);
    const { token } = await store.createBookingLink("usr_priya", "evt_coaching", {}, now);
    const viaLink = await handleCreateBooking(store, { ...request(second, { idempotencyKey: "key-code-link1" }), slug: undefined, event: undefined, linkToken: token }, now, undefined, null, undefined, null, codes);
    expect(viaLink.status).toBe(201);
    expect(sent).toHaveLength(0);
  });
});
