// The Clinic plan's price: ₹1,499 a month + 18% GST for up to 3 practitioners, ₹399 a month + GST for each extra
// practitioner, at most 10. Monthly, INR, through Razorpay only.
//
// Razorpay can't put two prices on one subscription, so there is one Razorpay Plan per practitioner count:
// RAZORPAY_PLAN_CLINIC_3_MONTH (₹1,499) … RAZORPAY_PLAN_CLINIC_10_MONTH (₹4,292). Changing the count moves the
// subscription to another of those Plans. Self-contained (no import from billing/plans) so plans.ts can use it.

type Env = Record<string, string | undefined>;

export const CLINIC_INCLUDED = 3;
export const CLINIC_MAX = 10;
/** Before GST, in paise. */
export const CLINIC_BASE_MINOR = 149_900;
export const CLINIC_EXTRA_MINOR = 39_900;
const GST = 0.18;

export const CLINIC_COUNTS = Array.from({ length: CLINIC_MAX - CLINIC_INCLUDED + 1 }, (_, i) => CLINIC_INCLUDED + i);

export function isClinicCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= CLINIC_INCLUDED && n <= CLINIC_MAX;
}

/** The monthly price before GST for `practitioners` places (3 to 10). */
export function clinicMonthlyMinor(practitioners: number): number {
  if (!isClinicCount(practitioners)) throw new RangeError(`Clinic covers ${CLINIC_INCLUDED} to ${CLINIC_MAX} practitioners, got ${practitioners}`);
  return CLINIC_BASE_MINOR + (practitioners - CLINIC_INCLUDED) * CLINIC_EXTRA_MINOR;
}

const inr = (minor: number) => {
  const major = minor / 100;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: Number.isInteger(major) ? 0 : 2, maximumFractionDigits: 2 }).format(major);
};

/** "₹1,499 + 18% GST = ₹1,768.82 a month", the same shape as the other plans' price lines. */
export function clinicPriceLine(practitioners: number): string {
  const base = clinicMonthlyMinor(practitioners);
  return `${inr(base)} + 18% GST = ${inr(Math.round(base * (1 + GST)))} a month`;
}

/** "₹399 + 18% GST = ₹470.82 a month for each practitioner after 3". */
export function clinicExtraLine(): string {
  return `${inr(CLINIC_EXTRA_MINOR)} + 18% GST = ${inr(Math.round(CLINIC_EXTRA_MINOR * (1 + GST)))} a month for each practitioner after ${CLINIC_INCLUDED}`;
}

export const clinicEnvName = (practitioners: number) => `RAZORPAY_PLAN_CLINIC_${practitioners}_MONTH`;

/** The Razorpay Plan id for that many practitioners, or null when it isn't configured. */
export function clinicPriceId(practitioners: number, env: Env = process.env): string | null {
  return isClinicCount(practitioners) ? env[clinicEnvName(practitioners)] || null : null;
}

/** How many practitioners a Razorpay Plan id stands for, or null when it isn't a Clinic plan. */
export function clinicCountForPriceId(provider: string, id: string, env: Env = process.env): number | null {
  if (provider !== "razorpay" || !id) return null;
  for (const n of CLINIC_COUNTS) if (env[clinicEnvName(n)] === id) return n;
  return null;
}
