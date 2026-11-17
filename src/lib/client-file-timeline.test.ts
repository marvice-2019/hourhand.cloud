import { describe, expect, it } from "vitest";
import { answerViews, decodeCursor, encodeCursor, loadClientFile, quickActions, type ClientFile } from "./client-file";
import { clientKey } from "./clients";
import { createMemoryStore } from "./data/memory-store";

describe("answerViews", () => {
  it("shows any answer shape as text under the label the guest saw, so new question kinds need no change", () => {
    expect(answerViews([
      { questionId: "a", label: "Goal", answer: "Sleep better" },
      { questionId: "b", label: "Topics", answer: ["sleep", "focus"] },
      { questionId: "c", label: "On medication?", answer: false },
      { questionId: "d", label: "Age", answer: 34 },
      { questionId: "e", label: "Born", answer: "1991-04-02", kind: "date" },
      { questionId: "f", label: "", answer: "label missing" },
      { questionId: "g", label: "Skipped", answer: "" },
      { questionId: "h", label: "Later kind", answer: { from: "a", to: "b" } },
      null, "junk",
    ])).toEqual([
      { label: "Goal", answer: "Sleep better" }, { label: "Topics", answer: "sleep, focus" }, { label: "On medication?", answer: "No" },
      { label: "Age", answer: "34" }, { label: "Born", answer: "1991-04-02" }, { label: "f", answer: "label missing" },
      { label: "Later kind", answer: '{"from":"a","to":"b"}' },
    ]);
    expect(answerViews(null)).toEqual([]);
  });
});

describe("cursor", () => {
  it("round-trips and rejects anything else", () => {
    const e = { at: new Date("2031-01-02T03:04:05Z"), kind: "booking" as const, id: "11111111-1111-4111-8111-111111111111" };
    expect(decodeCursor(encodeCursor(e))).toEqual(e);
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor(Buffer.from("2031-01-01T00:00:00Z|booking|x'; drop table").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("nope|package|11111111-1111-4111-8111-111111111111").toString("base64url"))).toBeNull();
  });
});

describe("quickActions", () => {
  const eventTypes = [{ id: "e1", slug: "intro", name: "Intro", paid: false }, { id: "e2", slug: "coaching", name: "Coaching", paid: false }, { id: "e3", slug: "deep-dive", name: "Deep dive", paid: true }];
  it("offers the client's last event type first, prefilled, marked as the host's booking, and ready-to-send rebook messages", () => {
    const a = quickActions({ baseUrl: "https://hourhand.cloud/", host: { slug: "priya", name: "Priya" }, client: { name: "Meera Iyer", email: "meera+1@example.com", phone: "9876543210", lastEventTypeId: "e2" }, eventTypes });
    expect(a.book.map((b) => b.path)).toEqual(["/priya/coaching?name=Meera%20Iyer&email=meera%2B1%40example.com&onbehalf=1", "/priya/intro?name=Meera%20Iyer&email=meera%2B1%40example.com&onbehalf=1"]);
    expect(a.rebookUrl).toBe("https://hourhand.cloud/priya/coaching?name=Meera%20Iyer&email=meera%2B1%40example.com");
    expect(a.whatsapp).toMatch(/^https:\/\/wa\.me\/919876543210\?text=Hi%20Meera%2C/);
    expect(decodeURIComponent(a.mailto!.split("body=")[1])).toBe(`Hi Meera, here's a link to book your next session with Priya: ${a.rebookUrl}`);
  });
  it("never offers to book a paid event for the client, but still sends them its link", () => {
    const a = quickActions({ baseUrl: "https://x", host: { slug: "p", name: "P" }, client: { name: "A", email: "a@b.c", phone: null, lastEventTypeId: "e3" }, eventTypes });
    expect(a.book.map((b) => b.name)).toEqual(["Intro", "Coaching"]);
    expect(a.rebookUrl).toBe("https://x/p/deep-dive?name=A&email=a%40b.c");
    expect(a.rebookUrl).not.toContain("onbehalf");
  });
  it("has nothing to send without a phone or an event type", () => {
    expect(quickActions({ baseUrl: "https://x", host: { slug: "p", name: "P" }, client: { name: "A", email: "a@b.c", phone: null, lastEventTypeId: null }, eventTypes }).whatsapp).toBeNull();
    expect(quickActions({ baseUrl: "https://x", host: { slug: "p", name: "P" }, client: { name: "A", email: "a@b.c", phone: null, lastEventTypeId: null }, eventTypes: [] })).toEqual({ book: [], rebookUrl: null, mailto: null, whatsapp: null });
  });
});

describe("loadClientFile in memory mode", () => {
  it("pages the demo bookings newest first with no gaps, without notes for a second person", async () => {
    const store = createMemoryStore();
    const host = (await store.getCurrentUser())!;
    const all = await store.listBookings(host.id);
    const email = all[0].invitee.email;
    const key = clientKey(email);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const f: ClientFile = (await loadClientFile(null, store, host.id, key, { owner: false }, { now: new Date(), cursor, limit: 1 }))!;
      expect(f.notes).toBeNull();
      seen.push(...f.entries.map((e) => e.id));
      cursor = f.nextCursor;
    } while (cursor);
    const expected = all.filter((b) => clientKey(b.invitee.email) === key && b.status !== "pending_payment" && !(b.status === "cancelled" && b.cancelledBy === "system"))
      .sort((a, b) => b.startAt.getTime() - a.startAt.getTime()).map((b) => b.id);
    expect(seen).toEqual(expected);
    expect(await loadClientFile(null, store, host.id, clientKey("nobody@example.com"), { owner: true }, { now: new Date() })).toBeNull();
  });
});
