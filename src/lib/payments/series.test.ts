import { describe, expect, it } from "vitest";
import { hostCancelRefundNote, refundPreview, refundTarget, seriesCharge, seriesPaymentNotes } from "./series";

describe("what cancelling refunds", () => {
  it("nothing paid: nothing shown", () => {
    expect(refundPreview(null, 0)).toBeNull();
  });

  it("a booking paid on its own (or its deposit) comes back in full, with or without later weeks", () => {
    expect(refundPreview({ amountMinor: 49_900, sessions: 1, refundedMinor: 0, refundDueMinor: 0 }, 0)).toEqual({ thisOnly: 49_900, withLater: 49_900 });
  });

  it("a week of a paid series refunds its share; with its later weeks, theirs too", () => {
    const series = { amountMinor: seriesCharge(50_000, 4), sessions: 4, refundedMinor: 0, refundDueMinor: 0 };
    expect(refundPreview(series, 0)).toEqual({ thisOnly: 50_000, withLater: 50_000 });
    expect(refundPreview(series, 2)).toEqual({ thisOnly: 50_000, withLater: 150_000 });
  });

  it("never shows more than is left on the payment after earlier refunds", () => {
    const series = { amountMinor: 200_000, sessions: 4, refundedMinor: 50_000, refundDueMinor: 100_000 };
    expect(refundPreview(series, 3)).toEqual({ thisOnly: 50_000, withLater: 50_000 });
    expect(refundPreview({ ...series, refundDueMinor: 150_000 }, 1)).toEqual({ thisOnly: 0, withLater: 0 });
  });

  it("the refund target is the whole payment once it's fully due, else what's refunded plus what's queued", () => {
    expect(refundTarget({ status: "refund_pending", amountMinor: 200_000, refundedMinor: 50_000, refundDueMinor: 0 })).toBe(200_000);
    expect(refundTarget({ status: "paid", amountMinor: 200_000, refundedMinor: 50_000, refundDueMinor: 50_000 })).toBe(100_000);
  });
});

describe("the host's booking page", () => {
  const money = (m: number) => `₹${(m / 100).toLocaleString("en-IN")}`;
  const series = { amountMinor: 200_000, sessions: 4, status: "paid", refundedMinor: 0, refundDueMinor: 0 };

  it("a series payment reads as its total, the count and the price each, with nothing about refunds yet", () => {
    expect(seriesPaymentNotes(series, money)).toEqual({ what: "₹2,000 for 4 weekly sessions (₹500 each)", refunds: null });
  });

  it("shows what is being refunded and what already was", () => {
    expect(seriesPaymentNotes({ ...series, refundDueMinor: 50_000 }, money).refunds).toBe("₹500 being refunded to the guest.");
    expect(seriesPaymentNotes({ ...series, refundedMinor: 50_000, refundDueMinor: 100_000 }, money).refunds).toBe("₹1,000 being refunded to the guest; ₹500 refunded so far.");
    // Everything left is due: the rest of the payment, after what went back earlier.
    expect(seriesPaymentNotes({ ...series, status: "refund_pending", refundedMinor: 50_000 }, money).refunds).toBe("₹1,500 being refunded to the guest; ₹500 refunded so far.");
    // Fully refunded: the status already says so.
    expect(seriesPaymentNotes({ ...series, status: "refunded", refundedMinor: 200_000 }, money).refunds).toBeNull();
  });

  it("a booking paid on its own keeps its existing wording", () => {
    expect(seriesPaymentNotes({ ...series, sessions: 1 }, money)).toEqual({ what: null, refunds: null });
  });

  it("the cancel form says what the guest gets back, with and without the later weeks", () => {
    expect(hostCancelRefundNote({ thisOnly: 50_000, withLater: 150_000 }, 2, money)).toBe("The guest gets ₹500 back (₹1,500 if you also cancel the later weeks), refunded from your Razorpay account.");
    expect(hostCancelRefundNote({ thisOnly: 49_900, withLater: 49_900 }, 0, money)).toBe("The guest gets ₹499 back, refunded from your Razorpay account.");
    expect(hostCancelRefundNote(null, 0, money)).toBeNull();
    expect(hostCancelRefundNote({ thisOnly: 0, withLater: 0 }, 1, money)).toBeNull();
  });
});
