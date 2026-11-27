# B15: check a day (why a time can or can't be booked)

Cal.com's availability troubleshooter shows a host each time on a day and what blocks it. Calendly, TidyCal, Zoho
Bookings and Topmate have nothing like it, so a coach who can't see Tuesday 4 pm on their booking page has to guess
between their hours, a calendar event, a buffer, the notice period or a limit, or write to support. Support load came
up in 14 reviews (docs/features.csv, fix 3). This adds a read-only "Check a day" page.

## Host
- Availability gets a line under its intro: "A time you expect isn't on your booking page? Check a day."
- /dashboard/availability/check: pick an event type (one-off meetings have no hours and aren't listed) and a day. The
  day defaults to today in the host's zone; a bad date shows an error and checks today.
- The result names the event type, the day and the schedule's zone, then "Guests can book N of M times." and every
  start the hours offer that day, each "Open" (with seats left for a group class) or one reason:
  - Already passed.
  - Too soon: the event type's notice, in minutes, as the editor shows it.
  - Too far ahead: the booking window in days.
  - Every seat is taken (group class).
  - The event type's daily or weekly limit is reached.
  - Clashes with a booking at a time (saying buffers count when the event type has them), with a link to the booking.
  - Busy in a named calendar from–to (the calendar's name, never the event's title).
  - Held for an open meeting poll from–to.
  - Hidden until calendars sync, with a banner linking Calendars when any connected calendar is out of date.
- A day with no hours says whether it's a day off (date override) or the weekday has no weekly hours, with a link to
  that schedule's hours. Below the list, a link to the event type's settings.
- A Duo second person managing someone's account sees that account's check, as they see its availability.
- It changes nothing and is open on every plan.

## Engine
- The slot engine's checks moved into one place that both the booking page (computeSlotSeats) and the check
  (explainDay) run, so the check can't say a time is open when the booking page hides it, or the reverse.
- Reasons are reported in the order a host would fix them: past, notice, window, seats, day limit, week limit, a
  booking, then calendar or poll busy time.

## Tests
- explainDay: every reason, the blocker it names, day off versus no weekly hours, a stale calendar, a group class on
  a full day, a daylight-saving day in London, and 300 mixed inputs where its open starts equal computeSlots exactly.
- checkDay on the demo store: open times equal the public slots API for that day; after a booking, that time names the
  booking by id.
