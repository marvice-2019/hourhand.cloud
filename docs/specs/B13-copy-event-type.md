# B13: copy an event type in one click

Calendly ("Duplicate"), Cal.com ("Duplicate"), Zoho Bookings ("Clone") and TidyCal let a host copy an event type and
change only what differs. In Hourhand a coach who offers the same session at 30 and 60 minutes, or for a new client
group, retypes every setting and question by hand. This adds a Duplicate button.

## Host
- Each card on Event types gets a "Duplicate" button beside "Copy link" (screen readers hear "Duplicate <name>").
- Pressing it makes the copy and opens the copy's editor, with a note: "Copied. This copy is switched off: rename it,
  check its link, then switch it on."
- A Duo second person managing someone's event types can copy them too, as they can create and edit them.

## The copy
- Name "<name> (copy)". Link "<slug>-copy", or "-copy-2", "-copy-3"… when taken, cut to the 60-character link limit.
  .
- Switched off, so nobody can book it until the host turns it on. Last in the list.
- Every other setting of the event type is copied, including ones added later: length options and prices, notice,
  window, increments, buffers, limits, group seats, hidden, schedule, policy, redirect, deposit, repeats, reminders,
  approval, email check, colour.
- Also copied: the location, the booking questions (a question shown only after a given answer points at the copy's
  own earlier question), follow-up settings, pay-what-you-can settings, and notification settings.
- Not copied: bookings, single-use links, packages, memberships, waitlist entries, routing form targets, clinic
  services and email codes. They belong to the original.
- One-off meetings (from polls and one-off links) aren't listed and can't be copied.

## Tests
- Postgres: settings, location, questions and their condition, follow-up settings and columns outside the editor
  (reminders, colour) are copied; the copy is off, last and has new ids; the original is unchanged; a second copy
  gets "-copy-2"; no bookings copied; someone else's event type, a bad id and a one-off are refused.
- Memory store: the same behaviour for the demo store.
- Name and link helpers: suffixes, the 60-character cut, a trailing hyphen dropped.
