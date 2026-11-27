import { describe, expect, it } from "vitest";
import type { BookingEmailKind } from "../data/notifications";
import { renderBookingMail, renderCalendarAlert, renderGuestEmailCode, renderMagicLink, type BookingMailContext } from "./templates";

const ctx: BookingMailContext = {
  bookingId: "b1", eventName: "Coaching", hostName: "Priya Sharma", hostEmail: "priya@example.com", hostTimezone: "Asia/Kolkata", hostTimeFormat: "24h",
  guestName: `Kiran <script>alert(1)</script>`, guestEmail: "kiran@example.com", guestTimezone: "Europe/London",
  startAt: new Date("2026-11-03T04:30:00Z"), endAt: new Date("2026-11-03T05:00:00Z"),
  location: { kind: "in_person", value: "12 MG Road" }, joinUrl: null, answers: [{ questionId: "q", label: "Goal", answer: "Plan the quarter" }],
  cancelledBy: "guest", cancelReason: "Sick\nday", previousStartAt: new Date("2026-11-02T04:30:00Z"),
  issuedAt: new Date("2026-10-11T00:00:00Z"),
  manageUrl: "https://hourhand.test/b/guest-only-manage-token", dashboardUrl: "https://hourhand.test/dashboard/bookings/b1",
};
const kinds: BookingEmailKind[] = ["booked_guest", "booked_host", "reminder_guest", "cancelled_guest", "cancelled_host", "rescheduled_guest", "rescheduled_host",
  "requested_guest", "requested_host", "declined_guest", "lapsed_guest"];

describe("booking emails", () => {
  it.each(kinds)("%s escapes guest input in HTML and keeps subjects on one line", (kind) => {
    const m = renderBookingMail(kind, ctx);
    expect(m.html).not.toContain("<script>");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text.length).toBeGreaterThan(0);
  });

  it.each(kinds.filter((k) => k.endsWith("_host")))("%s never contains the guest's manage link", (kind) => {
    const m = renderBookingMail(kind, ctx);
    expect(m.text + m.html).not.toContain("guest-only-manage-token");
  });

  it("offers the host-cancelled guest other times in their own zone, and only then", () => {
    const rebook = [{ at: new Date("2026-11-04T09:00:00Z"), url: "https://hourhand.test/priya/coaching?at=2026-11-04T09%3A00%3A00.000Z&x=<b>" }];
    const byHost = renderBookingMail("cancelled_guest", { ...ctx, cancelledBy: "host", rebook });
    expect(byHost.text).toContain("Book another time with Priya Sharma");
    expect(byHost.text).toContain("9:00 am Europe/London: https://hourhand.test/priya/coaching?at=");
    expect(byHost.html).toContain("&amp;x=&lt;b&gt;");
    expect(byHost.html).not.toContain("<b>");
    expect(renderBookingMail("cancelled_guest", { ...ctx, cancelledBy: "guest", rebook }).text).not.toContain("Book another time");
    expect(renderBookingMail("cancelled_guest", { ...ctx, cancelledBy: "host", rebook: [] }).text).not.toContain("Book another time");
    expect(renderBookingMail("cancelled_host", { ...ctx, cancelledBy: "host", rebook }).text).not.toContain("Book another time");
  });

  it("shows the guest their own time zone and the host theirs", () => {
    expect(renderBookingMail("booked_guest", ctx).text).toContain("4:30 am Europe/London");
    expect(renderBookingMail("booked_host", ctx).text).toContain("10:00 IST");
  });

  it("attaches a calendar file to confirmations and moves, and replies go to the other person", () => {
    const guest = renderBookingMail("booked_guest", ctx);
    expect(guest.attachments?.[0].filename).toBe("booking.ics");
    expect(guest.replyTo).toBe("priya@example.com");
    expect(renderBookingMail("rescheduled_guest", ctx).text).toContain("Was:");
    expect(renderBookingMail("booked_host", ctx).replyTo).toBe("kiran@example.com");
  });

  it("renders exactly the same email every time, so a retry with the same idempotency key is accepted", () => {
    expect(renderBookingMail("booked_guest", ctx)).toEqual(renderBookingMail("booked_guest", ctx));
    const ics = Buffer.from(renderBookingMail("booked_guest", ctx).attachments![0].content, "base64").toString("utf8");
    expect(ics).toContain("DTSTAMP:20261011T000000Z"); // from when it was queued, not the clock at send time
  });

  it("puts the guest's answers to questions in the host email", () => {
    expect(renderBookingMail("booked_host", ctx).text).toContain("Goal: Plan the quarter");
  });

  it("a paid booking shows what was paid, and its cancellation says the refund is on the way", () => {
    const paid = { ...ctx, paidMinor: 49900, cancelReason: null };
    expect(renderBookingMail("booked_guest", paid).text).toContain("₹499");
    expect(renderBookingMail("booked_host", paid).text).toContain("₹499 to your Razorpay account");
    expect(renderBookingMail("cancelled_guest", paid).text).toContain("Your payment of ₹499 is being refunded");
    expect(renderBookingMail("cancelled_host", paid).text).toContain("being refunded from your Razorpay account");
    const free = { ...ctx, paidMinor: null };
    expect(renderBookingMail("cancelled_guest", free).text).not.toContain("refund");
    expect(renderBookingMail("booked_guest", free).text).not.toContain("Paid");
  });

  it("a cancelled week of a paid series names its own refund, not the whole series' payment", () => {
    // As the worker builds it: the refund line carries the amount, with no series-total "Paid" row.
    const week = { ...ctx, paidMinor: null, seriesUnitMinor: 50000, refundMinor: 50000, cancelReason: null };
    expect(renderBookingMail("cancelled_guest", week).text).toContain("₹500 for the cancelled sessions is being refunded to the way you paid");
    expect(renderBookingMail("cancelled_guest", week).text).not.toContain("₹2,000");
    expect(renderBookingMail("cancelled_host", week).text).toContain("₹500 for the cancelled session is being refunded to the guest");
    const withLater = { ...week, refundMinor: 150000, alsoCancelled: [new Date(ctx.startAt.getTime() + 7 * 86_400_000), new Date(ctx.startAt.getTime() + 14 * 86_400_000)] };
    expect(renderBookingMail("cancelled_host", withLater).text).toContain("₹1,500 for the cancelled sessions");
    expect(renderBookingMail("cancelled_guest", { ...week, locale: "hi" }).text).toContain("₹500");
  });

  it("a moved booking says who moved it", () => {
    const moved = { ...ctx, previousStartAt: new Date(ctx.startAt.getTime() - 86_400_000) };
    expect(renderBookingMail("rescheduled_guest", { ...moved, movedBy: "host" }).text).toContain("moved your booking to a new time");
    expect(renderBookingMail("rescheduled_guest", { ...moved, movedBy: "guest" }).text).toContain("has moved");
    expect(renderBookingMail("rescheduled_host", { ...moved, movedBy: "host" }).text).toContain("You moved");
    expect(renderBookingMail("rescheduled_host", { ...moved, movedBy: "guest" }).text).toContain(`${ctx.guestName} moved`);
  });

  it("shows the Meet link once the calendar event has one", () => {
    const meet = { ...ctx, location: { kind: "google_meet" as const, value: null }, joinUrl: "https://meet.google.com/abc-defg-hij" };
    expect(renderBookingMail("booked_guest", meet).text).toContain("Google Meet: https://meet.google.com/abc-defg-hij");
  });

  it("the calendar alert says bookings are paused and links to the fix", () => {
    const m = renderCalendarAlert({ accountEmail: "priya@gmail.com", disconnected: true, lastError: "invalid_grant", calendarsUrl: "https://hourhand.test/dashboard/calendars" });
    expect(m.subject).toBe("Reconnect your Google Calendar");
    expect(m.text).toContain("https://hourhand.test/dashboard/calendars");
    expect(m.text).toContain("show no times");
  });

  it("sign-in email carries the link", () => {
    expect(renderMagicLink("https://hourhand.test/api/auth/magic-link/verify?token=t").text).toContain("token=t");
  });
});

describe("booking request emails (B9)", () => {
  const holdUntil = new Date("2026-10-13T00:00:00Z");

  it("asks the host to approve or decline in the dashboard, and says until when", () => {
    const m = renderBookingMail("requested_host", { ...ctx, holdUntil });
    expect(m.text).toContain("https://hourhand.test/dashboard/bookings/b1?decide=approve");
    expect(m.text).toContain("https://hourhand.test/dashboard/bookings/b1?decide=decline");
    expect(m.text).toContain("Decide by");
    expect(m.subject).toContain("Booking request");
  });

  it("tells the guest the request is sent, with their link to withdraw it, in their language", () => {
    const en = renderBookingMail("requested_guest", ctx);
    expect(en.subject).toMatch(/^Request sent/);
    expect(en.text).toContain("guest-only-manage-token");
    expect(en.attachments ?? []).toHaveLength(0); // not a booking yet: no calendar file
    expect(renderBookingMail("requested_guest", { ...ctx, locale: "ta" }).subject).toMatch(/^கோரிக்கை அனுப்பப்பட்டது/);
  });

  it("offers other times when a request is declined or runs out, with no link to a meeting", () => {
    const rebook = [{ at: new Date("2026-11-04T09:00:00Z"), url: "https://hourhand.test/priya/coaching?at=x" }];
    for (const kind of ["declined_guest", "lapsed_guest"] as const) {
      const m = renderBookingMail(kind, { ...ctx, joinUrl: "https://meet.example/abc", rebook });
      expect(m.text).toContain("https://hourhand.test/priya/coaching?at=x");
      expect(m.text).not.toContain("meet.example");
      expect(m.text).not.toContain("guest-only-manage-token");
    }
    expect(renderBookingMail("lapsed_guest", ctx).text).toContain("in time");
  });
});

describe("asking the guest to pick a new time (B10)", () => {
  it("links the guest's manage page and shows the host's note, escaped, in their language", () => {
    const m = renderBookingMail("reschedule_request_guest", { ...ctx, rescheduleNote: "Sorry <b>travelling</b>" });
    expect(m.subject).toContain("asked you to pick a new time");
    expect(m.text).toContain("guest-only-manage-token");
    expect(m.text).toContain("Sorry <b>travelling</b>");
    expect(m.html).not.toContain("<b>travelling</b>");
    expect(m.html).toContain("&lt;b&gt;travelling&lt;/b&gt;");
    expect(renderBookingMail("reschedule_request_guest", { ...ctx, locale: "ta" }).subject).toContain("புதிய நேரத்தைத்");
  });

  it("leaves the note row out when the host wrote none", () => {
    expect(renderBookingMail("reschedule_request_guest", ctx).text).not.toContain("Note from");
  });
});

describe("guest email code (B11)", () => {
  const c = { locale: "en" as const, code: "042917", guestName: "Kiran", hostName: "Priya <b>Sharma</b>", eventName: "Coaching" };

  it("shows the code, event and host, and says what to do if it wasn't asked for", () => {
    const m = renderGuestEmailCode(c);
    expect(m.subject).toBe("042917 is your code to book Coaching with Priya <b>Sharma</b>");
    expect(m.text).toContain("Code: 042917");
    expect(m.text).toContain("It works for 10 minutes.");
    expect(m.text).toContain("ignore this email");
  });

  it("escapes the host's name in the HTML", () => {
    const html = renderGuestEmailCode(c).html;
    expect(html).toContain("Priya &lt;b&gt;Sharma&lt;/b&gt;");
    expect(html).not.toContain("<b>Sharma</b>");
  });

  it("is written in the guest's language", () => {
    expect(renderGuestEmailCode({ ...c, locale: "hi" }).subject).toContain("आपका कोड 042917");
  });
});
