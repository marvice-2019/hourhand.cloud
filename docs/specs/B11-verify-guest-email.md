# B11: check the guest's email before booking

Cal.com ("Requires booker email verification") lets a host make guests prove their email before a booking is made. Hourhand takes any address typed in, so a typo means the guest never gets the confirmation, and anyone can fill a free host's calendar with fake bookings. This adds an opt-in check per event type.

## Host
- The event type editor gets a tick box "Check the guest's email before booking", with the hint "Guests enter a 6-digit code we email them. Stops fake and mistyped bookings." Off by default.
- Nothing else changes for the host. Bookings made after the check look like any other booking.

## Guest
- On an event type with the check on, after the guest picks a time, fills the form and presses Book, Hourhand emails a 6-digit code instead of booking. The page says "We've emailed a 6-digit code to {email}" with a code box, a Confirm button, "Send a new code" and "Change email".
- The right code makes the booking exactly as today (approval request, payment checkout, or confirmed booking). Nothing is booked or held before the code is right, so the slot can be taken meanwhile; the guest then sees the usual "that time was just taken" message.
- The email: subject "{code} is your code to book {event} with {host}", the code in large type, "It works for 10 minutes", and "If you didn't ask for this, ignore this email." In the guest's language (the 9 guest languages).

## When the check is skipped
- A booking the host makes for a client from the dashboard, one through a single-use link the host sent, and one paid by package link. The host chose the person in each case.
- A repeated submit of a booking already made (same request key) returns that booking as today.

## Rules
- A code is 6 digits, works for 10 minutes and only for the event type and email address it was sent to (case-insensitive). Only its hash is stored.
- 5 wrong tries on a code ends it; the guest asks for a new one.
- A new code at most once a minute and 5 times an hour per event type and address. Codes count toward the booking page's existing rate limits too.
- A right code is used up when the booking is made, so it can't book twice.

## Data (migration 0076)
- `event_types.verify_guest_email boolean not null default false`.
- `guest_email_codes`: id, event_type_id (cascade), email (lower case), code_hash, expires_at, attempts, used_at, created_at; indexed on event type, email and created_at.

## API
- `POST /api/bookings` on such an event type without `emailCode`: sends a code and answers 202 `{ "verification": "email_code_sent" }`; 429 `code_rate_limited` when asked too often; 502 `code_send_failed` when the email can't be sent.
- With `emailCode`: a wrong code answers 400 with `fields.emailCode`; an ended or expired code answers 400 `code_expired`; the right code continues to the booking as today.

## Tests
- Setting off: booking unchanged. Setting on: no code sends one and books nothing; the right code books; a wrong code is refused and counted; 5 wrong tries end the code; an expired code is refused; a used code can't book twice; another event type's or another address's code is refused; resend limits hold.
- Host on-behalf, single-use link and package bookings skip the check.
- The code email shows the code, the event and the host, escaped, in the guest's language.
