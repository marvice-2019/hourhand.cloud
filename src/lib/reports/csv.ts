import { GST_STATES } from "../gst/gst";
import type { GstDocument } from "./ledger";
import type { BusinessReport } from "./report";

// CSV exports for the host's accountant. Every text cell is escaped and guarded against formula injection: a cell that
// starts with = + - @ (or a tab or carriage return) is prefixed with an apostrophe so a spreadsheet shows it as text.
// Figures we format ourselves are written as plain numbers, so a credit note's "-500.00" still adds up.

/** A text cell: formula guard, then CSV quoting. */
export function textCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) || safe !== v ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A figure in minor units as a plain number with two decimals ("-1234.50"). */
export const amountCell = (minor: number) => (minor / 100).toFixed(2);

const row = (cells: string[]) => cells.join(",");
const lines = (rows: string[]) => rows.join("\r\n") + "\r\n";

/** "2026-04-01": the calendar date in India, which is what an Indian invoice goes by. */
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const stateLabel = (code: string) => `${code}-${GST_STATES[code] ?? "Unknown"}`;

export const GST_NOTE = "For your CA; verify before filing.";

export const GST_HEADER = [
  "Document type", "Invoice number", "Date", "Client name", "Client GSTIN", "Place of supply", "Supply type", "SAC", "Rate %",
  "Taxable value", "CGST", "SGST", "IGST", "Total", "Credit note references",
];

/**
 * One row per invoice or credit note (GSTR-1 preparation). Credit notes carry negative amounts and the invoice they
 * reverse; invoices list the credit notes that reverse them. Intra-state supplies show CGST and SGST, inter-state IGST.
 */
export function gstCsv(docs: GstDocument[], periodLabel: string): string {
  const rows = docs.map((d) => {
    const sign = d.kind === "credit_note" ? -1 : 1;
    const inter = d.igstMinor > 0 || (d.supplierState !== "" && d.placeOfSupply !== d.supplierState);
    return row([
      ...[d.kind === "invoice" ? "Invoice" : "Credit note", d.number, istDate(d.issuedAt), d.buyerName, d.buyerGstin, stateLabel(d.placeOfSupply),
        inter ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)", d.sac].map(textCell),
      (d.rateBp / 100).toFixed(2),
      ...[d.taxableMinor, d.cgstMinor, d.sgstMinor, d.igstMinor, d.totalMinor].map((m) => amountCell(sign * m)),
      textCell(d.references.join(" ")),
    ]);
  });
  return lines([row([textCell(`GST register, ${periodLabel}. ${GST_NOTE}`)]), row(GST_HEADER.map(textCell)), ...rows]);
}

/** A simple profit and loss per currency, then the monthly trend. GST lines are INR only (from the invoices). */
export function pnlCsv(r: BusinessReport, periodLabel: string): string {
  const out: string[] = [row(["Item", "Currency", "Amount"].map(textCell)), row([textCell("Period"), "", textCell(periodLabel)])];
  const add = (item: string, currency: string, minor: number) => out.push(row([textCell(item), textCell(currency), amountCell(minor)]));
  for (const c of r.currencies) {
    add("Income: session payments", c.currency, c.bookingsMinor);
    add("Income: packages", c.currency, c.packagesMinor);
    add("Income: forfeited deposits", c.currency, c.depositsKeptMinor);
    add("Less: refunds", c.currency, -c.refundsMinor);
    add("Net income", c.currency, c.netIncomeMinor);
    let after = c.netIncomeMinor;
    if (c.currency === "INR") {
      add("Less: GST output tax (from invoices)", c.currency, -r.gst.outputTaxMinor);
      after -= r.gst.outputTaxMinor;
    }
    if (c.feesReportedMinor !== null) {
      add("Less: payment gateway fees (reported)", c.currency, -c.feesReportedMinor);
      after -= c.feesReportedMinor;
    }
    if (c.feeEstimateMinor !== null) {
      add("Less: payment gateway fees (estimate)", c.currency, -c.feeEstimateMinor);
      after -= c.feeEstimateMinor;
    }
    add("Net after tax and fees", c.currency, after);
    if (c.depositsHeldMinor > 0) add("Memo: deposits still held (not income)", c.currency, c.depositsHeldMinor);
  }
  for (const t of r.trend) add(`Net income ${t.month}`, t.currency, t.netIncomeMinor);
  return lines(out);
}
