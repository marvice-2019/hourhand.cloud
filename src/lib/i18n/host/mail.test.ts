// Emails to the host follow the host's own language (users.host_locale), not the guest's.
import { describe, expect, it } from "vitest";
import { renderBookingMail, renderCalendarAlert, renderEarningsMail, renderPackageMail, renderRenewalReminder, type BookingMailContext } from "../../mail/templates";

const ctx: BookingMailContext = {
  bookingId: "b1", eventName: "Coaching", hostName: "Priya Sharma", hostEmail: "priya@example.com", hostTimezone: "Asia/Kolkata", hostTimeFormat: "12h",
  guestName: "Kiran", guestEmail: "kiran@example.com", guestTimezone: "Asia/Kolkata",
  startAt: new Date("2026-11-03T04:30:00Z"), endAt: new Date("2026-11-03T05:00:00Z"),
  location: { kind: "in_person", value: "12 MG Road" }, joinUrl: null, answers: [],
  cancelledBy: "guest", cancelReason: "Unwell", previousStartAt: new Date("2026-11-02T04:30:00Z"), paidMinor: 150000,
  issuedAt: new Date("2026-10-11T00:00:00Z"), runningLateMinutes: 10,
  manageUrl: "https://hourhand.test/b/manage-token", dashboardUrl: "https://hourhand.test/dashboard/bookings/b1",
};

describe("host emails in English", () => {
  it("keeps the English wording and figures", () => {
    const m = renderBookingMail("booked_host", { ...ctx, hostLocale: "en" });
    expect(m.subject).toBe("New booking: Kiran, Coaching, Tuesday, 3 November 2026");
    expect(m.text).toContain("What: Coaching (30 min)");
    expect(m.text).toContain("Paid: ₹1,500 to your Razorpay account");
    expect(m.text).toContain("Sent by Hourhand about your booking page.");
    expect(renderBookingMail("cancelled_host", ctx).text).toContain("Kiran cancelled Coaching.");
    expect(renderBookingMail("late_host", ctx).subject).toBe("Running late: Kiran, 10 min, Coaching");
    expect(renderBookingMail("rescheduled_host", ctx).text).toContain("Was: Monday, 2 November 2026, 10:00 am IST");
  });

  it("uses English for a missing or unknown host language, whatever the guest booked in", () => {
    const english = renderBookingMail("booked_host", ctx);
    expect(renderBookingMail("booked_host", { ...ctx, hostLocale: "fr", locale: "ta" })).toEqual(english);
    expect(renderCalendarAlert({ accountEmail: "p@gmail.com", disconnected: false, lastError: null, calendarsUrl: "u", hostLocale: "xx" }).subject).toBe("Hourhand can't read your Google Calendar");
    expect(renderRenewalReminder({ planName: "Solo", price: "₹399", renewsOn: ctx.startAt, timezone: "Asia/Kolkata", planUrl: "u" }).subject).toBe("Your Hourhand Solo plan renews on Tuesday, 3 November 2026");
    expect(renderEarningsMail({ monthLabel: "October 2026", netMinor: 12550000, bookingsMinor: 1, packagesMinor: 0, refundsMinor: 0, sessionsHeld: 3, noShows: 0, url: "u" }).subject).toBe("Your October 2026 on Hourhand: ₹1,25,500");
    const sold = renderPackageMail("package_host", { hostName: "Priya", hostEmail: "p@x.in", guestName: "Kiran", guestEmail: "k@x.in", packageName: "Five", eventName: "Coaching", sessions: 5, priceMinor: 500000, expiresAt: ctx.startAt, timezone: "Asia/Kolkata", buyerUrl: "b", dashboardUrl: "d" });
    expect(sold.subject).toBe("Package sold: Kiran, Five");
    expect(sold.text).toContain("Sessions: 5 × Coaching");
  });

  it("writes the poll-closed email as before", async () => {
    const { renderPollClosedMail } = await import("../../mail/templates");
    const base = { title: "Team sync", hostTimezone: "Asia/Kolkata", hostTimeFormat: "12h" as const, url: "u" };
    const m = renderPollClosedMail({ ...base, voters: 1, options: [{ startAt: ctx.startAt, yes: 2, ifNeeded: 1, no: 0, best: true }] });
    expect(m.subject).toBe("Voting closed: pick a time for Team sync");
    expect(m.text).toContain("1 person answered your poll for Team sync. Pick the time to book it for everyone who can make it.");
    expect(m.text).toContain("Tuesday, 3 November 2026, 10:00 am IST: 2 yes, 1 if needed, 0 no (best)");
    expect(m.text).toContain("The times are no longer held.");
    const none = renderPollClosedMail({ ...base, voters: 0, options: [] });
    expect(none.text).toContain("Nobody answered your poll for Team sync.");
    expect(none.text).toContain("All the proposed times have passed.");
    expect(renderPollClosedMail({ ...base, voters: 3, options: [] }).text).toContain("3 people answered");
  });

  it("writes the Zoom, data-request and membership emails to the host as before", async () => {
    const { renderZoomAlert, renderDataRequestMail, renderMembershipMail } = await import("../../mail/templates");
    expect(renderZoomAlert({ accountEmail: "z@x.in", lastError: null, integrationsUrl: "u" }).subject).toBe("Reconnect Zoom to keep sending meeting links");
    const req = renderDataRequestMail({ kind: "erasure", dueAt: ctx.startAt, timezone: "Asia/Kolkata", url: "u" });
    expect(req.subject).toBe("A client asked you to delete their data");
    expect(req.text).toContain("Respond by: Tuesday, 3 November 2026, 10:00 am IST");
    const joined = renderMembershipMail("host", { what: "joined", hostName: "Priya", hostEmail: "p@x.in", guestName: "Kiran", guestEmail: "k@x.in", planName: "Monthly 4",
      sessions: 4, priceMinor: 199950, creditsLeft: 4, paidThrough: null, timezone: "Asia/Kolkata", memberUrl: "m", dashboardUrl: "d" });
    expect(joined.subject).toBe("New member: Kiran, Monthly 4");
    expect(joined.text).toContain("Each month: 4 sessions for ₹1,999.50 a month");
    expect(joined.text).toContain("Member: Kiran <k@x.in>");
  });
});
