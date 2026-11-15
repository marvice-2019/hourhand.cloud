// Follow-ups without a database: signed links, what goes in the email and when it's skipped, review wording, package
// nudge thresholds, and the email in every guest language.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/guest";
import { FOLLOW_UP_CATALOGS, ft } from "../i18n/follow-up";
import {
  FOLLOW_UPS_OFF, STALE_AFTER_DAYS, packageNudgeKind, planFollowUp, renderFollowUpMail, reviewWording, validateFeedback, validateFollowUpForm,
  type FollowUpFacts, type FollowUpPlan,
} from "./follow-ups";
import { FEEDBACK_LINK_DAYS, feedbackToken, linkKey, optOutToken, readFeedbackToken, readOptOutToken } from "./tokens";

const key = randomBytes(32);
const BOOKING = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const HOST = "11111111-2222-4333-8444-555555555555";
const DAY = 86_400_000;
const issued = new Date("2030-01-01T10:00:00Z");

describe("feedback links", () => {
  it("open for the booking they were made for until 30 days after they were issued", () => {
    const token = feedbackToken(key, BOOKING, issued);
    expect(readFeedbackToken(key, token, new Date(issued.getTime() + 29 * DAY))).toEqual({ ok: true, bookingId: BOOKING });
    expect(readFeedbackToken(key, token, new Date(issued.getTime() + FEEDBACK_LINK_DAYS * DAY))).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse a changed booking id, expiry or signature, another server's key, and junk", () => {
    const token = feedbackToken(key, BOOKING, issued);
    const [, id, exp, sig] = token.split(".");
    const later = new Date(issued.getTime() + DAY);
    const otherId = "ffffffff-2222-4333-8444-555555555555";
    expect(readFeedbackToken(key, `f.${otherId}.${exp}.${sig}`, later)).toEqual({ ok: false, reason: "invalid" });
    // Pushing the expiry out is a forgery, not a renewal: it reads as invalid, never as valid or merely expired.
    expect(readFeedbackToken(key, `f.${id}.${Number(exp) + 86_400 * 365}.${sig}`, later)).toEqual({ ok: false, reason: "invalid" });
    expect(readFeedbackToken(key, `f.${id}.${exp}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, later)).toEqual({ ok: false, reason: "invalid" });
    expect(readFeedbackToken(randomBytes(32), token, later)).toEqual({ ok: false, reason: "invalid" });
    for (const junk of ["", "f..", 42, null, `${token}x`, "x".repeat(500)]) expect(readFeedbackToken(key, junk, later).ok).toBe(false);
  });

  it("can't be swapped with an opt-out link (each is signed for its own purpose)", () => {
    const opt = optOutToken(key, HOST, "guest@example.com");
    const sig = opt.split(".")[3];
    expect(readFeedbackToken(key, `f.${HOST}.${Math.floor(issued.getTime() / 1000) + 99}.${sig}`, issued).ok).toBe(false);
  });

  it("derive their key from TOKEN_ENCRYPTION_KEY, and refuse to work without it", () => {
    expect(linkKey("ab".repeat(32))).toHaveLength(32);
    expect(linkKey("ab".repeat(32)).equals(Buffer.from("ab".repeat(32), "hex"))).toBe(false);
    expect(() => linkKey(undefined)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe("opt-out links", () => {
  it("name the host and the guest's email, case-insensitively, and can't be altered", () => {
    const token = optOutToken(key, HOST, " Guest@Example.com ");
    expect(readOptOutToken(key, token)).toEqual({ hostId: HOST, email: "guest@example.com" });
    const [, , email, sig] = token.split(".");
    expect(readOptOutToken(key, `o.ffffffff-2222-4333-8444-555555555555.${email}.${sig}`)).toBeNull();
    expect(readOptOutToken(key, `o.${HOST}.${Buffer.from("someone@else.com").toString("base64url")}.${sig}`)).toBeNull();
  });
});

const facts = (over: Partial<FollowUpFacts> = {}): FollowUpFacts => ({
  status: "confirmed", noShow: false, optedOut: false, hostClosed: false, endAt: new Date("2030-01-01T10:00:00Z"),
  settings: { thankYou: true, feedback: true, reviewAsk: true, packageNudge: true, delayHours: 2 }, answered: false,
  reviewsUrl: "https://g.page/r/abc/review", rebookUrl: "https://hourhand.test/priya/coaching?name=A&email=a%40b.c", nudge: null, ...over,
});
const twoHoursLater = new Date("2030-01-01T12:00:00Z");

describe("when a follow-up is skipped", () => {
  it.each([
    [{ status: "cancelled" }, "booking cancelled"],
    [{ noShow: true }, "guest marked as a no-show"],
    [{ optedOut: true }, "guest opted out of this host's follow-ups"],
    [{ settings: FOLLOW_UPS_OFF }, "follow-ups switched off"],
    [{ hostClosed: true }, "host account closed"],
    [{ endAt: new Date("2030-01-01T13:00:00Z") }, "session not over yet"],
    [{ endAt: new Date(twoHoursLater.getTime() - (STALE_AFTER_DAYS + 1) * DAY) }, "too late for a follow-up"],
  ] as [Partial<FollowUpFacts>, string][])("%o → %s", (over, reason) => {
    expect(planFollowUp(facts(over), twoHoursLater)).toEqual({ skip: reason });
  });

  it("skips when what's switched on has nothing to say (review ask with no review link, nudge with no package)", () => {
    const only = (s: Partial<FollowUpFacts["settings"]>) => ({ ...FOLLOW_UPS_OFF, ...s });
    expect(planFollowUp(facts({ settings: only({ reviewAsk: true }), reviewsUrl: null }), twoHoursLater)).toEqual({ skip: "nothing to send" });
    expect(planFollowUp(facts({ settings: only({ packageNudge: true }) }), twoHoursLater)).toEqual({ skip: "nothing to send" });
    expect(planFollowUp(facts({ settings: only({ feedback: true }), answered: true }), twoHoursLater)).toEqual({ skip: "nothing to send" });
  });
});

describe("what goes in it", () => {
  it("with the feedback form on, keeps the review link for after the guest answers", () => {
    const plan = planFollowUp(facts(), twoHoursLater) as FollowUpPlan;
    expect(plan).toMatchObject({ thankYou: true, feedback: true, review: null });
    expect(plan.rebookUrl).toContain("/priya/coaching?");
  });

  it("with the feedback form off, offers the review link to every guest in the email", () => {
    const plan = planFollowUp(facts({ settings: { ...FOLLOW_UPS_OFF, reviewAsk: true } }), twoHoursLater) as FollowUpPlan;
    expect(plan).toMatchObject({ thankYou: false, feedback: false, review: "https://g.page/r/abc/review", rebookUrl: null });
  });
});

describe("the review ask after feedback", () => {
  it("is worded by the rating but offered for every rating (no review gating)", () => {
    expect([1, 2, 3, 4, 5].map(reviewWording)).toEqual(["reviewLow", "reviewLow", "reviewLow", "reviewHigh", "reviewHigh"]);
    // Both wordings carry the same link and invite a review; neither discourages one.
    for (const l of LOCALES) for (const k of ["reviewHigh", "reviewLow"] as const) expect(ft(l, k, { host: "H" })).toContain("Google");
  });
});

describe("package nudge thresholds", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  const p = (sessions: number, used: number, expiresAt: Date | null = new Date("2030-06-01T00:00:00Z")) => packageNudgeKind({ sessions, used, expiresAt }, now);
  it("nudges at 1 left and at none left, and not before", () => {
    expect(p(5, 3)).toBeNull();
    expect(p(5, 4)).toBe("one_left");
    expect(p(5, 5)).toBe("used_up");
    expect(p(2, 3)).toBe("used_up");
  });
  it("doesn't offer to book the last session of an expired package", () => {
    expect(p(5, 4, new Date("2029-12-31T00:00:00Z"))).toBeNull();
  });
});

describe("forms", () => {
  it("settings: boxes off unless ticked, delay 1, 2 or 24 hours only", () => {
    expect(validateFollowUpForm({})).toEqual({ ok: true, value: FOLLOW_UPS_OFF });
    expect(validateFollowUpForm({ thankYou: "on", feedback: "on", delayHours: "24" })).toEqual({ ok: true, value: { ...FOLLOW_UPS_OFF, thankYou: true, feedback: true, delayHours: 24 } });
    expect(validateFollowUpForm({ delayHours: "1" })).toMatchObject({ ok: true, value: { delayHours: 1 } });
    for (const d of ["0", "3", "48", "abc", "-1"]) expect(validateFollowUpForm({ delayHours: d }).ok).toBe(false);
  });

  it("feedback: a whole rating 1–5 and an optional plain-text comment up to 2,000 characters", () => {
    expect(validateFeedback({ rating: "4", comment: "  Great\r\nsession  " })).toEqual({ ok: true, rating: 4, comment: "Great\nsession" });
    expect(validateFeedback({ rating: "5", comment: "   " })).toEqual({ ok: true, rating: 5, comment: null });
    expect(validateFeedback({ rating: "5", comment: null })).toEqual({ ok: true, rating: 5, comment: null });
    for (const r of ["0", "6", "4.5", "", null, "five"]) expect(validateFeedback({ rating: r, comment: null })).toEqual({ ok: false, field: "rating" });
    expect(validateFeedback({ rating: "3", comment: "x".repeat(2001) })).toEqual({ ok: false, field: "comment" });
    // Stored as typed: markup is kept as text and only ever escaped when shown.
    expect(validateFeedback({ rating: "3", comment: "<script>alert(1)</script>" })).toMatchObject({ comment: "<script>alert(1)</script>" });
  });
});

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("in every guest language", () => {
  it("the catalog has every English line, non-empty, with the same placeholders", () => {
    for (const locale of LOCALES) {
      for (const [k, english] of Object.entries(FOLLOW_UP_CATALOGS.en)) {
        const line = (FOLLOW_UP_CATALOGS[locale] as Record<string, string | undefined>)[k];
        expect(line?.trim(), `${locale}.${k}`).toBeTruthy();
        expect(placeholders(line ?? ""), `${locale}.${k}`).toEqual(placeholders(english));
      }
    }
  });

  const full: FollowUpPlan = {
    thankYou: true, rebookUrl: "https://hourhand.test/priya/coaching?name=Kiran", feedback: true, review: "https://g.page/r/abc/review",
    nudge: { kind: "one_left", packageName: "5 sessions", bookUrl: "https://hourhand.test/p/tok", buyUrl: "https://hourhand.test/pkg/pk" },
  };
  const ctx = {
    guestName: "Kiran <b>", hostName: "Priya & Co", hostEmail: "priya@example.com", eventName: "Coaching",
    feedbackUrl: "https://hourhand.test/b/feedback/f.tok", optOutUrl: "https://hourhand.test/b/stop/o.tok",
  };

  it.each(LOCALES)("renders %s with every part, no missing strings, and escaped names", (locale) => {
    const m = renderFollowUpMail({ ...ctx, locale }, full);
    for (const body of [m.subject, m.text, m.html]) expect(body).not.toMatch(/\{\w+\}|undefined|null/);
    expect(m.text).toContain(ft(locale, "intro", { host: "Priya & Co", event: "Coaching" }));
    for (const n of [1, 2, 3, 4, 5]) expect(m.text).toContain(`https://hourhand.test/b/feedback/f.tok?r=${n}`);
    for (const url of ["https://g.page/r/abc/review", "https://hourhand.test/p/tok", "https://hourhand.test/pkg/pk", "https://hourhand.test/priya/coaching?name=Kiran", "https://hourhand.test/b/stop/o.tok"]) {
      expect(m.text).toContain(url);
      expect(m.html).toContain(url);
    }
    expect(m.html).not.toContain("Kiran <b>");
    expect(m.html).toContain("Kiran &lt;b&gt;");
    expect(m.html).toContain("Priya &amp; Co");
    expect(m.replyTo).toBe("priya@example.com");
    if (locale !== "en") expect(m.text).not.toContain(FOLLOW_UP_CATALOGS.en.feedbackHeading);
  });

  it("leaves out what isn't switched on: a thank-you alone has no rating buttons, review, nudge or rebook link", () => {
    const m = renderFollowUpMail({ ...ctx, locale: "en" }, { thankYou: true, rebookUrl: null, feedback: false, review: null, nudge: null });
    expect(m.text).not.toMatch(/feedback|g\.page|\/p\/|\/pkg\//);
    expect(m.text).toContain("b/stop/"); // the opt-out link is always there
  });

  it("says all sessions are used and offers to buy again when none are left", () => {
    const m = renderFollowUpMail({ ...ctx, locale: "en" }, { ...full, nudge: { kind: "used_up", packageName: "5 sessions", bookUrl: null, buyUrl: "https://hourhand.test/pkg/pk" } });
    expect(m.text).toContain("You've used all your sessions in 5 sessions.");
    expect(m.text).toContain("Buy 5 sessions again: https://hourhand.test/pkg/pk");
    expect(m.text).not.toContain("Book your last session");
  });
});
