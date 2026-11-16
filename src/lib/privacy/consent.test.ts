import { describe, expect, it } from "vitest";
import { handleCreateBooking, handleGetSlots } from "../booking";
import { createMemoryStore } from "../data/memory-store";
import { buildSeed } from "../data/seed";
import type { CreateBookingInput, DataStore } from "../data/types";
import { t } from "../i18n/guest";
import { bookingStatement, consentFor, PRIVACY_NOTICE_VERSION } from "./consent";

const now = new Date("2026-10-10T04:00:00Z");
const DAY = 86_400_000;

/** A memory store that remembers what each createBooking was asked to write. */
function spyStore(): { store: DataStore; inputs: CreateBookingInput[] } {
  const store = createMemoryStore(buildSeed(now));
  const inputs: CreateBookingInput[] = [];
  const createBooking = store.createBooking.bind(store);
  store.createBooking = async (input) => { inputs.push(input); return createBooking(input); };
  return { store, inputs };
}

async function firstSlot(store: DataStore): Promise<string> {
  const params = new URLSearchParams({ slug: "priya", event: "coaching", from: now.toISOString(), to: new Date(now.getTime() + 14 * DAY).toISOString(), tz: "Asia/Kolkata" });
  return ((await handleGetSlots(store, params, now)).body as { slots: string[] }).slots[0];
}

describe("consent log", () => {
  it("lists the booking, WhatsApp when ticked, and each consent question ticked or not", () => {
    const lines = consentFor({
      hostName: "Priya", channel: "booking_page", whatsappOptIn: true, whatsappStatement: "Send me updates on WhatsApp.",
      questions: [
        { id: "q1", label: "I agree to follow-up emails", kind: "consent" },
        { id: "q2", label: "I consent to session recording", kind: "consent" },
        { id: "q3", label: "Your goal", kind: "short_text" },
      ],
      answers: [{ questionId: "q1", label: "I agree to follow-up emails", answer: "yes" }, { questionId: "q3", label: "Your goal", answer: "Clarity" }],
    });
    expect(lines).toEqual([
      { purpose: "booking", granted: true, statement: bookingStatement("Priya"), noticeVersion: PRIVACY_NOTICE_VERSION, channel: "booking_page" },
      { purpose: "whatsapp_updates", granted: true, statement: "Send me updates on WhatsApp.", noticeVersion: PRIVACY_NOTICE_VERSION, channel: "booking_page" },
      { purpose: "host_question", granted: true, statement: "I agree to follow-up emails", noticeVersion: PRIVACY_NOTICE_VERSION, channel: "booking_page" },
      { purpose: "host_question", granted: false, statement: "I consent to session recording", noticeVersion: PRIVACY_NOTICE_VERSION, channel: "booking_page" },
    ]);
  });

  it("logs SMS updates only when ticked, with the words shown", () => {
    const base = { hostName: "Priya", channel: "booking_page" as const, whatsappOptIn: false, whatsappStatement: "WA", questions: [], answers: [] };
    expect(consentFor({ ...base, smsOptIn: true, smsStatement: "Text me by SMS." }).map((l) => [l.purpose, l.statement])).toEqual([
      ["booking", bookingStatement("Priya")], ["sms_updates", "Text me by SMS."]]);
    expect(consentFor({ ...base, smsOptIn: false, smsStatement: "Text me by SMS." }).map((l) => l.purpose)).toEqual(["booking"]);
  });

  it("is handed to the store with every new booking, in the guest's language, and WhatsApp only with a phone", async () => {
    const { store, inputs } = spyStore();
    const host = (await store.getUserBySlug("priya"))!;
    const coaching = (await store.listEventTypes(host.id)).find((e) => e.slug === "coaching")!;
    const existing = await store.listCustomQuestions(host.id, coaching.id);
    await store.saveQuestions(host.id, coaching.id, [
      ...existing.map((q) => ({ id: q.id, label: q.label, kind: q.kind, required: q.required, choices: q.choices })),
      { id: null, label: "Okay to email me a follow-up", kind: "consent", required: false, choices: [] },
    ]);
    const start = await firstSlot(store);
    const answers = Object.fromEntries(existing.filter((q) => q.required).map((q) => [q.id, "Something"]));
    const res = await handleCreateBooking(store, {
      slug: "priya", event: "coaching", start, name: "Meera Iyer", email: "meera@example.com", timezone: "Asia/Kolkata", phone: "+91 98765 43210",
      whatsappOptIn: true, locale: "hi", answers, idempotencyKey: "consent-key-0001",
    }, now);
    expect(res.status).toBe(201);
    const consent = inputs[0].invitee.consent!;
    expect(consent.map((c) => [c.purpose, c.granted])).toEqual([["booking", true], ["whatsapp_updates", true], ["host_question", false]]);
    expect(consent[1].statement).toBe(t("hi", "whatsappOptIn"));
    expect(consent.every((c) => c.channel === "booking_page" && c.noticeVersion === PRIVACY_NOTICE_VERSION)).toBe(true);
  });
});
