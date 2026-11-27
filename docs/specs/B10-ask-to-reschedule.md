# B10: ask the guest to pick a new time

Calendly, Cal.com and Topmate let a host who can't make a booking ask the guest to choose another time. Hourhand lets the host move a booking themselves, or cancel it, but not hand the choice to the guest. This adds that.

## Host
- The booking page (`/dashboard/bookings/{id}`) gets "Ask {guest} to pick a new time" under "Change this booking", with an optional note (up to 500 characters, for example why).
- Only for an upcoming, confirmed booking that isn't a seat in a group class. Asking once per booking; the page then says when the host asked.
- The Bookings list shows "Asked for a new time" on such a booking until it is moved or cancelled.

## Guest
- One email: "{host} asked you to pick a new time", with the current time, the host's note and a "Pick a new time" button to the manage page.
- The manage page shows the same ask and the note above the reschedule form. The guest reschedules as today (no cut-off applies to a guest's move).

## What doesn't change
- The booking stays confirmed, in the host's calendar and paid as it was, until the guest moves it. Payments, refunds and reminders are untouched; if the guest never moves it, it happens at the original time or the host cancels it.
- Moving makes a new booking as today, so the ask ends with the old one.

## Data (migration 0075)
- `bookings.reschedule_requested_at timestamptz`, `bookings.reschedule_request_note text` (at most 500 characters).
- Notification kind `reschedule_request_guest` (email to the main guest only, skipped once the booking is moved, cancelled or over).

## Tests
- Asking stores the time and note and queues one email; asking again is refused; past, cancelled, group-seat and another host's bookings are refused.
- The guest moving it leaves the ask behind on the cancelled old booking; the email is skipped once it's cancelled.
- The email shows the note escaped.
