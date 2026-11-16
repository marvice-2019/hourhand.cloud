// The membership form's errors (MEMBERSHIP_PLAN_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { MEMBERSHIP_LIMITS, MEMBERSHIP_PLAN_MESSAGES, validatePlanForm } from "../../memberships/memberships";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode } from "./lib-messages";

// Same map as src/app/dashboard/memberships/actions.ts.
const KEYS: Record<keyof typeof MEMBERSHIP_PLAN_MESSAGES, HostKey> = {
  name: "memberships.errName",
  sessionsRange: "memberships.errSessionsRange",
  priceInvalid: "memberships.errPrice",
  rollover: "memberships.errRollover",
  capRange: "memberships.errCapRange",
  eventTypesNone: "memberships.errEventTypesNone",
  eventTypesMax: "memberships.errEventTypesMax",
};

const form = { name: "Coaching Plus", sessions: "4", price: "6000", rollover: "capped", rolloverCap: "4", eventTypeIds: ["00000000-0000-4000-8000-000000000001"] };
const errorsOf = (f: typeof form) => {
  const v = validatePlanForm(f);
  if (v.ok) throw new Error("expected errors");
  return v.errors;
};

describe("membership messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(MEMBERSHIP_PLAN_MESSAGES)) expect(HOST_CATALOGS.en[KEYS[code as keyof typeof KEYS]]).toBe(template);
  });

  it("decodes real messages", () => {
    const { sessions: s, rolloverCap: c, maxEventTypes } = MEMBERSHIP_LIMITS;
    expect(decode(MEMBERSHIP_PLAN_MESSAGES, errorsOf({ ...form, sessions: "0" }).sessions!)).toEqual({ code: "sessionsRange", vars: { min: String(s.min), max: String(s.max) } });
    expect(decode(MEMBERSHIP_PLAN_MESSAGES, errorsOf({ ...form, rolloverCap: "" }).rolloverCap!)).toEqual({ code: "capRange", vars: { min: String(c.min), max: String(c.max) } });
    const many = Array.from({ length: maxEventTypes + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(decode(MEMBERSHIP_PLAN_MESSAGES, errorsOf({ ...form, eventTypeIds: many }).eventTypeIds!)).toEqual({ code: "eventTypesMax", vars: { max: String(maxEventTypes) } });
    expect(decode(MEMBERSHIP_PLAN_MESSAGES, errorsOf({ ...form, price: "abc" }).price!)).toEqual({ code: "priceInvalid", vars: {} });
  });
});
