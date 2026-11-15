import { describe, expect, it } from "vitest";
import { refundPreview, refundTarget, seriesCharge } from "./series";

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
