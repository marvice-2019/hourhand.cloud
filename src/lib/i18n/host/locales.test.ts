// Hindi and Tamil for the host: dates, numbers and rupees in the host's language, and the host's own emails.
import { describe, expect, it } from "vitest";
import { renderBookingMail, renderCalendarAlert, renderEarningsMail, renderPollClosedMail, renderRenewalReminder, type BookingMailContext } from "../../mail/templates";
import { HOST_CATALOGS, ht } from "./index";
import { hostMonth, makeHostI18n } from "./format";
import { hostPriceLine } from "./price";

const at = new Date("2026-11-03T04:30:00Z");

describe("dates, times, numbers and rupees per language", () => {
  it("names months and weekdays in Hindi and Tamil, with Latin digits", () => {
    expect(makeHostI18n("hi").date(at, "Asia/Kolkata")).toBe("मंगलवार, 3 नवंबर 2026");
    expect(makeHostI18n("ta").date(at, "Asia/Kolkata")).toBe("செவ்வாய், 3 நவம்பர், 2026");
    expect(hostMonth(new Date("2026-10-01T00:00:00Z"), "hi")).toBe("अक्टूबर 2026");
    expect(hostMonth(new Date("2026-10-01T00:00:00Z"), "ta")).toBe("அக்டோபர் 2026");
    for (const l of ["hi", "ta"] as const) expect(makeHostI18n(l).time(at, "Asia/Kolkata", "24h")).toBe("10:00");
  });

  it("groups numbers and rupees the Indian way in every language", () => {
    for (const l of ["en", "hi", "ta"] as const) {
      const i = makeHostI18n(l);
      expect(i.number(1234567)).toBe("12,34,567");
      expect(i.inr(12550000)).toBe("₹1,25,500");
      expect(i.inr(12345)).toBe("₹123.45");
    }
  });

  it("writes the plan price line in the host's language", () => {
    expect(hostPriceLine("solo", "month", "INR", makeHostI18n("hi"))).toMatch(/^₹\d+ \+ 18% GST = ₹[\d.,]+ /);
    expect(hostPriceLine("solo", "month", "INR", makeHostI18n("hi"))).toContain(HOST_CATALOGS.hi["plan.priceGstMonth"].split("{total}")[1]);
  });
});

const ctx: BookingMailContext = {
  bookingId: "b1", eventName: "Coaching", hostName: "Priya", hostEmail: "priya@example.com", hostTimezone: "Asia/Kolkata", hostTimeFormat: "12h",
  guestName: "Kiran", guestEmail: "kiran@example.com", guestTimezone: "Asia/Kolkata", startAt: at, endAt: new Date("2026-11-03T05:00:00Z"),
  location: { kind: "in_person", value: "12 MG Road" }, joinUrl: null, answers: [], cancelledBy: "guest", cancelReason: null, previousStartAt: null,
  paidMinor: 150000, issuedAt: new Date("2026-10-11T00:00:00Z"), manageUrl: "https://h.test/b/t", dashboardUrl: "https://h.test/dashboard/bookings/b1",
};

describe("host emails follow the host's language", () => {
  it("writes a Tamil host's new-booking email in Tamil, whatever the guest booked in", () => {
    const m = renderBookingMail("booked_host", { ...ctx, hostLocale: "ta", locale: "hi" });
    expect(m.subject).toBe(ht("ta", "mail.subjNewBooking", { guest: "Kiran", event: "Coaching", date: makeHostI18n("ta").date(at, "Asia/Kolkata") }));
    expect(m.text).toContain(ht("ta", "mail.rPaidValue", { amount: "₹1,500", provider: "Razorpay" }));
    expect(m.text).toContain(ht("ta", "mail.footer"));
    expect(m.text).not.toMatch(/New booking|Sent by Hourhand about/);
    // The guest's own confirmation stays in the guest's language.
    expect(renderBookingMail("booked_guest", { ...ctx, hostLocale: "ta", locale: "hi" }).subject.startsWith("बुक हो गया:")).toBe(true);
  });

  it("writes cancellations, moves and late notices in Hindi", () => {
    const hi = { ...ctx, hostLocale: "hi" };
    expect(renderBookingMail("cancelled_host", hi).text).toContain(ht("hi", "mail.iCancelledByGuest", { guest: "Kiran", event: "Coaching" }));
    expect(renderBookingMail("rescheduled_host", { ...hi, previousStartAt: new Date("2026-11-02T04:30:00Z"), movedBy: "host" }).text)
      .toContain(`${ht("hi", "mail.rWas")}: ${makeHostI18n("hi").date(new Date("2026-11-02T04:30:00Z"), "Asia/Kolkata")}`);
    expect(renderBookingMail("late_host", { ...hi, runningLateMinutes: 10 }).subject).toBe(ht("hi", "mail.subjLate", { guest: "Kiran", n: 10, event: "Coaching" }));
  });

  it("writes calendar alerts, renewal, earnings and poll emails in the host's language", () => {
    const alert = renderCalendarAlert({ accountEmail: "p@gmail.com", disconnected: true, lastError: null, calendarsUrl: "u", hostLocale: "ta" });
    expect(alert.subject).toBe(HOST_CATALOGS.ta["mail.subjCalDisconnected"]);
    expect(alert.text).toContain("p@gmail.com");
    const renewal = renderRenewalReminder({ planName: "Solo", price: "₹399", renewsOn: at, timezone: "Asia/Kolkata", planUrl: "u", hostLocale: "hi" });
    expect(renewal.subject).toBe(ht("hi", "mail.subjRenewal", { plan: "Solo", date: makeHostI18n("hi").date(at, "Asia/Kolkata") }));
    const month = hostMonth(new Date("2026-10-01T00:00:00Z"), "ta");
    const earnings = renderEarningsMail({ monthLabel: month, netMinor: 12550000, bookingsMinor: 0, packagesMinor: 0, refundsMinor: 0, sessionsHeld: 4, noShows: 1, url: "u", hostLocale: "ta" });
    expect(earnings.subject).toBe(ht("ta", "mail.subjEarnings", { month, amount: "₹1,25,500" }));
    const poll = renderPollClosedMail({ title: "Batch 3", hostTimezone: "Asia/Kolkata", hostTimeFormat: "12h", hostLocale: "hi", voters: 2, options: [], url: "u" });
    expect(poll.subject).toBe(ht("hi", "mail.subjPollClosed", { title: "Batch 3" }));
  });
});
