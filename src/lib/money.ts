/**
 * An amount in minor units (paise, cents, pence) in its currency: "₹499", "$12.50", "£30", "€9.99". Any currency with a
 * hundredths minor unit; Hourhand doesn't charge in zero-decimal currencies. Unknown codes fall back to "12.50 XYZ".
 */
export function formatAmount(minor: number, currency: string | null | undefined): string {
  const code = (currency ?? "INR").toUpperCase();
  const major = minor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", { style: "currency", currency: code, minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${code}`;
  }
}

/** The symbol or code shown next to a price field: "₹", "$", "£", "€", or the code itself. */
export function currencyLabel(currency: string | null | undefined): string {
  const code = (currency ?? "INR").toUpperCase();
  try {
    const part = new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", { style: "currency", currency: code }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}
