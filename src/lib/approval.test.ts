import { describe, expect, it } from "vitest";
import { approvalHoldUntil } from "./approval";

const HOUR = 3_600_000;
const now = new Date("2026-11-26T08:00:00Z");

describe("approvalHoldUntil", () => {
  it("waits 48 hours for a booking further out", () => {
    expect(approvalHoldUntil(now, new Date(now.getTime() + 7 * 24 * HOUR))).toEqual(new Date(now.getTime() + 48 * HOUR));
  });

  it("ends an hour before a booking that starts sooner", () => {
    expect(approvalHoldUntil(now, new Date(now.getTime() + 10 * HOUR))).toEqual(new Date(now.getTime() + 9 * HOUR));
  });

  it("holds until the start for a booking inside its last hour", () => {
    const start = new Date(now.getTime() + 30 * 60_000);
    expect(approvalHoldUntil(now, start)).toEqual(start);
  });
});
