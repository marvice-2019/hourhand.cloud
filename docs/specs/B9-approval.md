# B9: booking requests the host approves

Calendly, Cal.com, Zoho Bookings and Topmate let a host review a booking before it is confirmed. Hourhand confirms every free booking at once. This adds an opt-in per event type.

## 1. The setting
- The event-type editor gets a switch under Scheduling rules: "I approve each booking first". It sets `event_types.requires_approval` (default false, so nothing changes for existing event types).
- It can be on only for a free one-on-one event type: no price, no deposit, `kind = 'one_on_one'`, and weekly repeats off (`max_repeats = 1`). The save action refuses the combination with a plain error; the editor greys the switch out with the reason.
  - Paid events already hold the slot while the guest pays. Mixing the two touches payments, which is out of scope here.

## 2. What the guest sees
- Booking such an event creates the booking as `pending_approval`. It holds the slot exactly like a payment hold: `hold_expires_at` is set, and the slot shows as taken to everyone else while the hold is live.
  - The hold lasts until the earlier of 48 hours after booking and 1 hour before the start.
  - An event type whose minimum notice is shorter than 1 hour still works: the hold then ends at the start.
- The confirmation page says "Request sent" instead of "You're booked", says the host will confirm by email, and shows no calendar buttons and no join link.
- The guest gets a "Request received" email (guest languages, like every guest email). No WhatsApp or SMS.
- The manage page (`/b/{token}`) shows "Waiting for {host} to confirm" and lets the guest withdraw the request (a cancel). It offers no reschedule while pending.

## 3. What the host sees
- A "New booking request" email with two buttons, Approve and Decline, plus a phone alert when phone alerts are on.
  - Each button links to the booking's dashboard page (`/dashboard/bookings/{id}?decide=approve|decline`), so the host must be signed in as the booking's host. A GET never changes anything: Approve is a form button there, and Decline asks once more before it runs.
- The Bookings page shows "Waiting for your approval" on each live request, a count line, and a "Show only requests" link.
- The booking detail page shows Approve and Decline and when the hold runs out.

## 4. Approve, decline, lapse
- **Approve**: in one transaction, guarded on `status = 'pending_approval' and hold_expires_at > now()`: set `confirmed`, clear the hold, then `queueBookingNotifications(..., "booked")`. So the guest gets the normal booked email, and the calendar event, Zoom meeting, reminders, webhooks and follow-up all happen exactly as for a normal booking.
  - The host's own "New booking" email is not sent again on approve (`notifyHost: false`): they just approved it.
- **Decline**: guarded the same way: set `cancelled`, `cancelled_by = 'host'`, `cancel_reason = 'Request declined'`, clear the hold. The guest gets a "Request declined" email with free times to book instead (the existing cancelled-email alternatives).
- **Lapse**: the job runner cancels lapsed requests (`cancelled_by = 'system'`, `cancel_reason = 'Not confirmed in time'`) and emails the guest that the request wasn't confirmed in time, with alternatives. The booking insert also sweeps them (as it does for payment holds), so a lapsed request never blocks a new booking.
- A decision on a booking that is no longer pending returns what happened instead ("Already approved", "Already declined", "This request ran out").

## 5. Not in scope
- Bookings the host makes themselves (on behalf), through a single-use link, or with a package are confirmed at once: the host chose them.
- Rescheduling a confirmed booking does not need approval again.
- Paid events, group classes and weekly series can't turn the setting on (section 1).

## Data (migration 0074)
- `event_types.requires_approval boolean not null default false`.
- `bookings_status_check` gains `pending_approval`.
- `bookings_hold_check` becomes `(status in ('pending_payment','pending_approval')) = (hold_expires_at is not null)`.
- `no_double_booking` covers `pending_approval` too.
- Notification kinds: `requested_guest`, `requested_host`, `declined_guest`, `lapsed_guest`.

## Tests
- Slots: a live request hides its slot; a lapsed one doesn't.
- Insert: a request is stored as `pending_approval` with the right hold; on-behalf, link and package bookings stay `confirmed`.
- Approve queues the booked jobs once and not the host email; approving twice is a no-op; approving a lapsed one fails.
- Decline and lapse email the guest once each.
- Saving `requires_approval` on a paid, group or repeating event type is refused.
- A decision refuses another host's booking.
- e2e: book a request, approve it from the dashboard, see the booked page change.
