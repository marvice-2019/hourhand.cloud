// The plan price line in the host's language: "₹399 + 18% GST = ₹470.82 a month". The English matches priceLine.
import { ADDON_PRICES, formatMoney, GST_RATE, priceParts, type Addon, type BillingInterval, type Currency, type PaidPlan } from "../../billing/plans";
import type { HostI18n } from "./format";

export function hostPriceLine(plan: PaidPlan, interval: BillingInterval, currency: Currency, i18n: Pick<HostI18n, "t" | "inr">): string {
  const { base, total } = priceParts(plan, interval, currency);
  if (total === null) return i18n.t(interval === "month" ? "plan.priceMonth" : "plan.priceYear", { price: formatMoney(base, currency) });
  return i18n.t(interval === "month" ? "plan.priceGstMonth" : "plan.priceGstYear", { base: i18n.inr(base), total: i18n.inr(total) });
}

/** An add-on's price line, as addonPriceLine words it: "₹199 + 18% GST = ₹234.82 a month". */
export function hostAddonPriceLine(addon: Addon, i18n: Pick<HostI18n, "t" | "inr">): string {
  const base = ADDON_PRICES[addon].month.INR;
  return i18n.t("plan.priceGstMonth", { base: i18n.inr(base), total: i18n.inr(Math.round(base * (1 + GST_RATE))) });
}
