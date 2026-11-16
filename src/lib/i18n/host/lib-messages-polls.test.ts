// The new-poll errors (POLL_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { checkPoll, POLL_LIMITS, POLL_MESSAGES, type PollInput } from "../../polls/polls";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode } from "./lib-messages";

// Same map as src/app/dashboard/polls/actions.ts.
const POLL_KEYS: Record<keyof typeof POLL_MESSAGES, HostKey> = {
  title: "polls.errTitle",
  description: "polls.errDescription",
  duration: "polls.errDuration",
  location: "polls.errLocation",
  locationAddress: "polls.errLocationAddress",
  locationPhone: "polls.errLocationPhone",
  locationDetails: "polls.errLocationDetails",
  timesAhead: "polls.errTimesAhead",
  timesCount: "polls.errTimesCount",
  timesFuture: "polls.errTimesFuture",
  timesOnce: "polls.errTimesOnce",
  deadlineFuture: "polls.errDeadlineFuture",
  deadlineFirst: "polls.errDeadlineFirst",
  deadlineMax: "polls.errDeadlineMax",
};

const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
};

const now = new Date("2026-10-01T00:00:00Z");
const t = (days: number) => new Date(now.getTime() + days * 86_400_000);
const input = (over: Partial<PollInput> = {}): PollInput => ({
  title: "Kickoff", description: null, durationMinutes: 60, location: { kind: "google_meet", value: null },
  times: [t(2), t(3)], holdTimes: true, deadline: null, ...over,
});

describe("polls messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(POLL_MESSAGES)) expect(HOST_CATALOGS.en[POLL_KEYS[code as keyof typeof POLL_KEYS]]).toBe(template);
  });

  it("decodes real messages", () => {
    const tooFew = message(() => checkPoll(input({ times: [t(2)] }), now));
    expect(tooFew).toBe("Propose 2 to 8 times.");
    expect(decode(POLL_MESSAGES, tooFew)).toEqual({ code: "timesCount", vars: { min: String(POLL_LIMITS.minTimes), max: String(POLL_LIMITS.maxTimes) } });
    const farOff = message(() => checkPoll(input({ times: [t(2), t(400)] }), now));
    expect(decode(POLL_MESSAGES, farOff)).toEqual({ code: "timesAhead", vars: { n: String(POLL_LIMITS.maxAheadDays) } });
    const noAddress = message(() => checkPoll(input({ location: { kind: "in_person", value: " " } }), now));
    expect(decode(POLL_MESSAGES, noAddress)).toEqual({ code: "locationAddress", vars: {} });
    const noPhone = message(() => checkPoll(input({ location: { kind: "phone_guest_calls", value: "" } }), now));
    expect(decode(POLL_MESSAGES, noPhone)).toEqual({ code: "locationPhone", vars: {} });
    const late = message(() => checkPoll(input({ times: [t(70), t(71)], deadline: t(65) }), now));
    expect(decode(POLL_MESSAGES, late)).toEqual({ code: "deadlineMax", vars: { n: String(POLL_LIMITS.maxDeadlineDays) } });
    const once = message(() => checkPoll(input({ times: [t(2), t(2)] }), now));
    expect(decode(POLL_MESSAGES, once)).toEqual({ code: "timesOnce", vars: {} });
  });
});
