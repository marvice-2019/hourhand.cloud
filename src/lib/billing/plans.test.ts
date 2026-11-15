import { describe, expect, it } from "vitest";
import { effectivePlan, planForPriceId, priceLine, providerPriceId } from "./plans";

const env = { RAZORPAY_PLAN_SOLO_MONTH: "plan_solo_m", STRIPE_PRICE_DUO_YEAR: "price_duo_y" };

describe("plans", () => {
  it("shows INR with GST separately and USD without it", () => {
    expect(priceLine("solo", "month", "INR")).toBe("₹399 + 18% GST = ₹470.82 a month");
    expect(priceLine("duo", "year", "INR")).toBe("₹5,990 + 18% GST = ₹7,068.20 a year");
    expect(priceLine("solo", "month", "USD")).toBe("$7 a month");
  });

  it("maps provider ids both ways, and an unknown id to nothing", () => {
    expect(providerPriceId("razorpay", "solo", "month", env)).toBe("plan_solo_m");
    expect(providerPriceId("stripe", "solo", "month", env)).toBeNull();
    expect(planForPriceId("stripe", "price_duo_y", env)).toEqual({ plan: "duo", interval: "year" });
    expect(planForPriceId("stripe", "price_someone_else", env)).toBeNull();
  });

  it("grants a paid plan only while active or retrying a payment", () => {
    expect(effectivePlan(null)).toBe("free");
    expect(effectivePlan({ plan: "solo", status: "active" })).toBe("solo");
    expect(effectivePlan({ plan: "solo", status: "past_due" })).toBe("solo");
    expect(effectivePlan({ plan: "duo", status: "paused" })).toBe("free");
    expect(effectivePlan({ plan: "duo", status: "unpaid" })).toBe("free");
    expect(effectivePlan({ plan: "duo", status: "cancelled" })).toBe("free");
  });
});

describe("custom domain add-on", () => {
  it("is ₹199 + 18% GST = ₹234.82 a month", async () => {
    const { addonPriceLine, ADDON_PRICES } = await import("./plans");
    expect(ADDON_PRICES.domain.month.INR).toBe(19_900);
    expect(addonPriceLine("domain")).toBe("₹199 + 18% GST = ₹234.82 a month");
  });

  it("knows its Razorpay plan id only from RAZORPAY_PLAN_DOMAIN_MONTH, and never on Stripe", async () => {
    const { addonForPriceId, addonPriceId, planForPriceId } = await import("./plans");
    const env = { RAZORPAY_PLAN_DOMAIN_MONTH: "plan_dom", RAZORPAY_PLAN_SOLO_MONTH: "plan_solo" };
    expect(addonPriceId("domain", env)).toBe("plan_dom");
    expect(addonPriceId("domain", {})).toBeNull();
    expect(addonForPriceId("razorpay", "plan_dom", env)).toBe("domain");
    expect(addonForPriceId("razorpay", "plan_solo", env)).toBeNull();
    expect(addonForPriceId("stripe", "plan_dom", env)).toBeNull();
    // The add-on id is never mistaken for a plan.
    expect(planForPriceId("razorpay", "plan_dom", env)).toBeNull();
  });

  it("is live while active or retrying, and stops at the end of a cancelled period", async () => {
    const { addonLive } = await import("./plans");
    const end = new Date("2026-12-15T00:00:00Z");
    const before = new Date("2026-12-14T23:59:59Z");
    expect(addonLive(null)).toBe(false);
    expect(addonLive({ status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: end }, before)).toBe(true);
    expect(addonLive({ status: "past_due", cancelAtPeriodEnd: false, currentPeriodEnd: end }, before)).toBe(true);
    for (const status of ["paused", "unpaid", "cancelled"] as const) expect(addonLive({ status, cancelAtPeriodEnd: false, currentPeriodEnd: end }, before)).toBe(false);
    expect(addonLive({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: end }, before)).toBe(true);
    expect(addonLive({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: end }, end)).toBe(false);
  });
});
