import { describe, expect, it } from "vitest";
import { amountCell, gstCsv, GST_HEADER, pnlCsv, textCell } from "./csv";
import { money, percent } from "./format";
import type { GstDocument, MoneyEntry, SessionRow } from "./ledger";
import { resolvePeriod } from "./period";
import { sessionStats, summarize } from "./report";

const IST = "Asia/Kolkata";
const now = new Date("2026-11-15T06:00:00Z");
const period = resolvePeriod({ period: "custom", from: "2026-10-01", to: "2026-10-31" }, IST, now);
const at = (s: string) => new Date(s);

const entry = (o: Partial<MoneyEntry> & Pick<MoneyEntry, "type" | "amountMinor">): MoneyEntry => ({
  source: "booking", currency: "INR", at: at("2026-10-10T06:00:00Z"), clientKey: "asha@example.in", clientName: "Asha", eventTypeId: "et1", eventName: "Coaching", feeMinor: null, feeTaxMinor: null, ...o,
});
const session = (o: Partial<SessionRow>): SessionRow => ({
  startAt: at("2026-10-10T06:00:00Z"), status: "confirmed", cancelledBy: null, cancelledAt: null, rescheduled: false, noShow: false, cancelCutoffMinutes: 0,
  clientKey: "asha@example.in", eventTypeId: "et1", eventName: "Coaching", ...o,
});

describe("business report arithmetic", () => {
  const money_: MoneyEntry[] = [
    entry({ type: "sale", amountMinor: 100_000 }),
    entry({ type: "sale", amountMinor: 50_000, clientKey: "ravi@example.in", clientName: "Ravi" }),
    entry({ type: "refund", amountMinor: 50_000, clientKey: "ravi@example.in", clientName: "Ravi", at: at("2026-10-12T06:00:00Z") }),
    entry({ type: "sale", source: "package", amountMinor: 400_000, clientKey: "kiran@example.in", clientName: "Kiran", eventTypeId: "et2", eventName: "Mentoring" }),
    entry({ type: "deposit_kept", source: "deposit", amountMinor: 20_000, clientKey: "ravi@example.in", clientName: "Ravi", eventTypeId: "et3", eventName: "Intro" }),
    entry({ type: "deposit_held", source: "deposit", amountMinor: 20_000, eventTypeId: "et3", eventName: "Intro" }),
    // A Stripe payment in dollars: its own totals, never added to rupees.
    entry({ type: "sale", currency: "USD", amountMinor: 9_900, clientKey: "sam@example.com", clientName: "Sam", feeMinor: 317 }),
    entry({ type: "fee", currency: "USD", amountMinor: 317, clientKey: "sam@example.com", feeTaxMinor: 0 }),
    // September money for the trend only.
    entry({ type: "sale", amountMinor: 30_000, at: at("2026-09-20T06:00:00Z") }),
    // 1 Oct 00:30 in India is October, though UTC still says 30 September.
    entry({ type: "sale", amountMinor: 70_000, at: at("2026-09-30T19:00:00Z") }),
  ];
  const r = summarize({ period, now, money: money_, sessions: [], documents: [], trendFrom: at("2026-08-31T18:30:00Z") });

  it("keeps each currency apart", () => {
    expect(r.currencies.map((c) => c.currency)).toEqual(["INR", "USD"]);
    expect(r.currencies[1]).toMatchObject({ grossMinor: 9_900, netIncomeMinor: 9_900, feesReportedMinor: 317, feeEstimateMinor: null });
  });

  it("nets refunds, adds forfeited deposits, and leaves held deposits out of income", () => {
    expect(r.currencies[0]).toMatchObject({
      bookingsMinor: 220_000, packagesMinor: 400_000, grossMinor: 620_000, refundsMinor: 50_000, netSalesMinor: 570_000,
      depositsKeptMinor: 20_000, netIncomeMinor: 590_000, depositsHeldMinor: 20_000, feesReportedMinor: null,
      feeEstimateMinor: Math.round((640_000 * 200 * 1.18) / 10_000),
    });
  });

  it("ranks clients by what they paid net of refunds, per currency", () => {
    expect(r.topClients.map((c) => [c.currency, c.name, c.netMinor])).toEqual([
      ["INR", "Kiran", 400_000], ["INR", "Asha", 170_000], ["INR", "Ravi", 20_000], ["USD", "Sam", 9_900],
    ]);
  });

  it("splits revenue by event type", () => {
    expect(r.byEventType.filter((l) => l.currency === "INR").map((l) => [l.eventName, l.bookingsMinor, l.packagesMinor, l.depositsKeptMinor]))
      .toEqual([["Mentoring", 0, 400_000, 0], ["Coaching", 170_000, 0, 0], ["Intro", 0, 0, 20_000]]);
  });

  it("trends month on month in the host's zone", () => {
    expect(r.trendMonths).toEqual(["2026-09", "2026-10"]);
    expect(r.trend.filter((t) => t.currency === "INR").map((t) => [t.month, t.netIncomeMinor])).toEqual([["2026-09", 30_000], ["2026-10", 590_000]]);
  });

  it("counts sessions, no-show rate and late cancellations", () => {
    const s = sessionStats([
      session({}), session({}), session({}),
      session({ noShow: true }),
      session({ startAt: at("2026-11-20T06:00:00Z") }), // upcoming
      session({ status: "cancelled", cancelledBy: "guest", cancelledAt: at("2026-10-09T07:00:00Z") }), // 23h before: late
      session({ status: "cancelled", cancelledBy: "guest", cancelledAt: at("2026-10-08T05:00:00Z") }), // 2 days before
      session({ status: "cancelled", cancelledBy: "guest", cancelledAt: at("2026-10-08T05:00:00Z"), cancelCutoffMinutes: 72 * 60 }), // inside a 72h cut-off
      session({ status: "cancelled", cancelledBy: "host", cancelledAt: at("2026-10-10T05:00:00Z") }),
      session({ status: "cancelled", cancelledBy: "guest", rescheduled: true, cancelledAt: at("2026-10-10T05:00:00Z") }), // a reschedule
      session({ status: "cancelled", cancelledBy: "system", cancelledAt: at("2026-10-10T05:00:00Z") }), // an unpaid hold released
    ], now);
    expect(s).toEqual({ delivered: 3, upcoming: 1, noShows: 1, noShowRate: 0.25, cancelled: 4, cancelledByGuest: 3, cancelledByHost: 1, lateCancellations: 2 });
    expect(sessionStats([], now).noShowRate).toBeNull();
    expect(percent(0.25)).toBe("25%");
  });

  it("uses Razorpay's real fees where known and estimates only the rest", () => {
    const r2 = summarize({
      period, now, sessions: [], documents: [], trendFrom: period.from,
      money: [
        entry({ type: "sale", amountMinor: 100_000, feeMinor: 2_360 }),
        entry({ type: "fee", amountMinor: 2_360, feeTaxMinor: 360 }),
        entry({ type: "sale", amountMinor: 50_000 }), // fee not in yet
        // A refunded deposit: its fee stays a cost though the money went back.
        entry({ type: "fee", source: "deposit", amountMinor: 472, feeTaxMinor: 72 }),
      ],
    });
    expect(r2.currencies[0]).toMatchObject({ feesReportedMinor: 2_832, feeTaxReportedMinor: 432, feeEstimateMinor: Math.round((50_000 * 200 * 1.18) / 10_000) });
    expect(r2.topClients.map((c) => c.netMinor)).toEqual([150_000]); // fees aren't client revenue
    const all = summarize({ period, now, sessions: [], documents: [], trendFrom: period.from,
      money: [entry({ type: "sale", amountMinor: 100_000, feeMinor: 2_360 }), entry({ type: "fee", amountMinor: 2_360, feeTaxMinor: 360 })] });
    expect(all.currencies[0].feeEstimateMinor).toBeNull(); // every fee known: no estimate at all
  });

  it("shows INR with Indian digit grouping", () => {
    expect(money(123_456_750, "INR")).toBe("₹12,34,567.50");
    expect(money(150_000_00, "INR")).toBe("₹1,50,000");
    expect(money(123_456_700, "USD")).toBe("$1,234,567");
  });
});

describe("CSV exports", () => {
  it("guards cells against formula injection and escapes quotes, commas and newlines", () => {
    expect(textCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    for (const lead of ["=", "+", "-", "@"]) expect(textCell(`${lead}1+1`)).toBe(`"'${lead}1+1"`);
    expect(textCell("\tcmd")).toBe(`"'\tcmd"`);
    expect(textCell("Rao, Asha")).toBe(`"Rao, Asha"`);
    expect(textCell("line1\nline2")).toBe(`"line1\nline2"`);
    expect(textCell("Plain name")).toBe("Plain name");
    expect(amountCell(-50_000)).toBe("-500.00"); // our own figures stay numbers
  });

  const doc = (o: Partial<GstDocument>): GstDocument => ({
    kind: "invoice", number: "HH/2627/000001", issuedAt: at("2026-10-01T06:00:00Z"), buyerName: "Asha", buyerGstin: "", supplierState: "29", placeOfSupply: "29",
    sac: "999293", rateBp: 1800, taxableMinor: 84_746, cgstMinor: 7_627, sgstMinor: 7_627, igstMinor: 0, totalMinor: 100_000, references: [], ...o,
  });

  it("writes GST columns: CGST/SGST within a state, IGST across states, credit notes negative with references", () => {
    const csv = gstCsv([
      doc({ references: ["CNHH/2627/000001"] }),
      doc({ number: "HH/2627/000002", buyerName: "=cmd|' /C calc'!A0", placeOfSupply: "27", cgstMinor: 0, sgstMinor: 0, igstMinor: 15_254 }),
      doc({ kind: "credit_note", number: "CNHH/2627/000001", issuedAt: at("2026-10-31T19:00:00Z"), references: ["HH/2627/000001"] }),
    ], "2026-10-01 to 2026-10-31");
    const rows = csv.trimEnd().split("\r\n");
    expect(rows[0]).toContain("For your CA; verify before filing.");
    expect(rows[1]).toBe(GST_HEADER.join(","));
    expect(rows[2]).toBe("Invoice,HH/2627/000001,2026-10-01,Asha,,29-Karnataka,Intra-state (CGST+SGST),999293,18.00,847.46,76.27,76.27,0.00,1000.00,CNHH/2627/000001");
    expect(rows[3]).toBe(`Invoice,HH/2627/000002,2026-10-01,"'=cmd|' /C calc'!A0",,27-Maharashtra,Inter-state (IGST),999293,18.00,847.46,0.00,0.00,152.54,1000.00,`);
    // Dated in India: 1 Nov 00:30 IST.
    expect(rows[4]).toBe("Credit note,CNHH/2627/000001,2026-11-01,Asha,,29-Karnataka,Intra-state (CGST+SGST),999293,18.00,-847.46,-76.27,-76.27,0.00,-1000.00,HH/2627/000001");
  });

  it("writes a P&L per currency with GST and fees taken off", () => {
    const r = summarize({
      period, now, trendFrom: period.from, sessions: [],
      money: [entry({ type: "sale", amountMinor: 118_000 }), entry({ type: "refund", amountMinor: 18_000 }), entry({ type: "sale", currency: "USD", amountMinor: 1_000, feeMinor: 59 }),
        entry({ type: "fee", currency: "USD", amountMinor: 59, feeTaxMinor: 9 })],
      documents: [doc({ taxableMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, totalMinor: 118_000 })],
    });
    const csv = pnlCsv(r, "Oct");
    expect(csv).toContain("Net income,INR,1000.00\r\n");
    expect(csv).toContain("Less: GST output tax (from invoices),INR,-180.00\r\n");
    expect(csv).toContain("Less: refunds,INR,-180.00\r\n");
    expect(csv).toContain(`Less: payment gateway fees (estimated until Razorpay reports them),INR,-${((118_000 * 0.02 * 1.18) / 100).toFixed(2)}\r\n`);
    expect(csv).toContain("Less: payment gateway fees (as charged incl. GST),USD,-0.59\r\n");
    expect(csv).toContain("Memo: GST in gateway fees (input tax credit; check with your CA),USD,0.09\r\n");
    expect(csv).not.toMatch(/output tax.*USD/); // GST output tax is a rupee figure only
  });
});
