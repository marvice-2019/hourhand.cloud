// The one-off meeting errors (LINK_MESSAGES, ONE_OFF_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { checkOneOff, MAX_ONE_OFF_TIMES, ONE_OFF_MESSAGES } from "../../data/one-off";
import { LINK_MESSAGES, parseLocalTimes } from "../../links-form";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode } from "./lib-messages";

// Same maps as src/app/dashboard/links/actions.ts.
const LINK_KEYS: Record<keyof typeof LINK_MESSAGES, HostKey> = {
  timeNotDateTime: "links.errTimeNotDateTime",
  timeNotRealDate: "links.errTimeNotRealDate",
  timeClockChange: "links.errTimeClockChange",
};
const ONE_OFF_KEYS: Record<keyof typeof ONE_OFF_MESSAGES, HostKey> = {
  name: "links.errName",
  duration: "links.errDuration",
  timesCount: "links.errTimesCount",
  timesFuture: "links.errTimesFuture",
  timesOnce: "links.errTimesOnce",
};

const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
};

describe("links messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(LINK_MESSAGES)) expect(HOST_CATALOGS.en[LINK_KEYS[code as keyof typeof LINK_KEYS]]).toBe(template);
    for (const [code, template] of Object.entries(ONE_OFF_MESSAGES)) expect(HOST_CATALOGS.en[ONE_OFF_KEYS[code as keyof typeof ONE_OFF_KEYS]]).toBe(template);
  });

  it("decodes real messages", () => {
    const parsed = parseLocalTimes(["", "2026-02-31T10:00"], "Asia/Kolkata");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(decode(LINK_MESSAGES, parsed.error)).toEqual({ code: "timeNotRealDate", vars: { n: "2" } });
    const noFormat = parseLocalTimes(["tomorrow"], "Asia/Kolkata");
    if (!noFormat.ok) expect(decode(LINK_MESSAGES, noFormat.error)).toEqual({ code: "timeNotDateTime", vars: { n: "1" } });

    const now = new Date("2026-10-01T00:00:00Z");
    const base = { name: "Chat", durationMinutes: 30, description: null, location: { kind: "phone_host_calls" as const, value: null } };
    const tooMany = message(() => checkOneOff({ ...base, times: [] } as never, now));
    expect(decode(ONE_OFF_MESSAGES, tooMany)).toEqual({ code: "timesCount", vars: { n: String(MAX_ONE_OFF_TIMES) } });
    const past = message(() => checkOneOff({ ...base, times: [new Date("2026-09-01T00:00:00Z")] } as never, now));
    expect(decode(ONE_OFF_MESSAGES, past)).toEqual({ code: "timesFuture", vars: {} });
  });
});
