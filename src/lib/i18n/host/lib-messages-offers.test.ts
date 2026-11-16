// The offer forms' errors (OFFER_FORM_MESSAGES) and discount wording (DISCOUNT_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { OFFER_FORM_MESSAGES, parseDiscount, validateCampaignForm, validateCouponForm, validateSlidingForm } from "../../offers/manage";
import { DISCOUNT_MESSAGES, MAX_PERCENT, describeDiscount } from "../../offers/pricing";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode, translator } from "./lib-messages";

// Same maps as src/app/dashboard/offers/actions.ts and page.tsx.
const KEYS: Record<keyof typeof OFFER_FORM_MESSAGES, HostKey> = {
  percent: "offers.errPercent",
  fixed: "offers.errFixed",
  kind: "offers.errKind",
  maxUses: "offers.errMaxUses",
  maxUsesPerEmail: "offers.errMaxUsesPerEmail",
  code: "offers.errCode",
  expiresOn: "offers.errExpiresOn",
  rupees: "offers.errRupees",
  suggested: "offers.errSuggested",
  note: "offers.errNote",
  name: "offers.errName",
  banner: "offers.errBanner",
  startsOn: "offers.errStartsOn",
  endsOn: "offers.errEndsOn",
  endsPassed: "offers.errEndsPassed",
  endsBeforeStart: "offers.errEndsBeforeStart",
};
const DISCOUNT_KEYS: Record<keyof typeof DISCOUNT_MESSAGES, HostKey> = { percent: "offers.percentOff", fixed: "offers.rupeesOff" };

const today = "2026-11-16";
const coupon = { code: "DIWALI20", kind: "percent", value: "20", expiresOn: "", maxUses: "", maxUsesPerEmail: "", eventTypeIds: [], packageIds: [] };
const campaign = { name: "Diwali offer", banner: "20% off", kind: "percent", value: "20", startsOn: today, endsOn: "2026-11-20", eventTypeIds: [], packageIds: [] };
const errorsOf = <T,>(v: { ok: true; value: T } | { ok: false; errors: Record<string, string> }) => {
  if (v.ok) throw new Error("expected errors");
  return v.errors;
};

describe("offer messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(OFFER_FORM_MESSAGES)) expect(HOST_CATALOGS.en[KEYS[code as keyof typeof KEYS]]).toBe(template);
    for (const [code, template] of Object.entries(DISCOUNT_MESSAGES)) expect(HOST_CATALOGS.en[DISCOUNT_KEYS[code as keyof typeof DISCOUNT_KEYS]]).toBe(template);
  });

  it("decodes real form errors", () => {
    const errors: Record<string, string> = {};
    parseDiscount("percent", "95", errors);
    expect(decode(OFFER_FORM_MESSAGES, errors.value)).toEqual({ code: "percent", vars: { max: String(MAX_PERCENT) } });
    const c = errorsOf(validateCouponForm({ ...coupon, code: "x", maxUses: "0", maxUsesPerEmail: "abc" }, today));
    expect(decode(OFFER_FORM_MESSAGES, c.code)).toEqual({ code: "code", vars: {} });
    expect(decode(OFFER_FORM_MESSAGES, c.maxUses)).toEqual({ code: "maxUses", vars: {} });
    expect(decode(OFFER_FORM_MESSAGES, c.maxUsesPerEmail)).toEqual({ code: "maxUsesPerEmail", vars: {} });
    const m = errorsOf(validateCampaignForm({ ...campaign, endsOn: "2026-11-01" }, today));
    expect(decode(OFFER_FORM_MESSAGES, m.endsOn)).toEqual({ code: "endsPassed", vars: {} });
    const s = errorsOf(validateSlidingForm({ min: "500", suggested: "100", max: "900", note: "" }));
    expect(decode(OFFER_FORM_MESSAGES, s.suggested)).toEqual({ code: "suggested", vars: {} });
  });

  it("decodes real discount wording and shows the host line", () => {
    expect(decode(DISCOUNT_MESSAGES, describeDiscount({ kind: "percent", value: 20 }))).toEqual({ code: "percent", vars: { n: "20" } });
    expect(decode(DISCOUNT_MESSAGES, describeDiscount({ kind: "fixed", value: 19950 }))).toEqual({ code: "fixed", vars: { amount: "199.50" } });
    const t = (key: HostKey, vars: Record<string, string | number> = {}) => `${key}:${JSON.stringify(vars)}`;
    expect(translator(DISCOUNT_MESSAGES, DISCOUNT_KEYS)(t, "₹200 off")).toBe('offers.rupeesOff:{"amount":"200"}');
  });
});
