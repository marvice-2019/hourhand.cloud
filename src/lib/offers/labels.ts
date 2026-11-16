// Offer wording for guest pages and emails. Client-safe: no database imports.
import { t, type Locale } from "../i18n/guest";
import type { AdjustmentKind, Discount } from "./pricing";

/** What an adjustment is called on the guest's page, in their language. A campaign keeps the host's own name for it. */
export function offerLabel(locale: Locale, o: { kind: AdjustmentKind; label: string; code: string | null }): string {
  if (o.kind === "coupon") return t(locale, "offerKindCode", { code: o.code ?? "" });
  if (o.kind === "first_session") return t(locale, "offerKindFirst");
  if (o.kind === "sliding_scale") return t(locale, "offerKindSliding");
  return o.label;
}

/** "20%" or "₹200". */
export const discountText = (d: Discount) => (d.kind === "percent" ? `${d.value}%` : `₹${(d.value / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
