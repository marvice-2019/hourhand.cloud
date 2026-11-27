# B12: find and download bookings

Calendly (filters and Export on Scheduled events), Cal.com (bookings filters) and Zoho Bookings (appointment search and
export) let a host find a booking by the client's name and download their bookings. Hourhand's Bookings page lists
everything, upcoming first, with no search, no filter and no event type on each row. A coach with a few hundred
sessions scrolls to find one. This adds search, filters and a CSV download to the Bookings page.

## Host
- Above the list: a search box ("Name, email or phone"), a Show select (All, Upcoming, Past, Cancelled, Requests),
  an Event type select (All event types, then each of the host's event types), From and To dates, a Search button and
  a Clear link. It is a plain GET form, so a filtered list has its own URL and works without JavaScript.
- Each row also shows the event type's name.
- A line says how many bookings match. The page shows the first 200; past that it says "Showing 200 of N" and
  suggests narrowing the search or downloading them.
- "Download these as CSV" downloads every booking that matches, not just the 200 shown.
- The existing "Show only requests" link keeps working (`?show=requests` reads as Show: Requests).

## Matching
- Search: case-insensitive, trimmed, at most 100 characters. Matches the guest's name, email, extra guests' emails,
  or phone (digits only, at least 3, so "98765" finds "+91 98765 43210").
- Show: Upcoming = not cancelled and not yet ended; Past = not cancelled and ended; Cancelled; Requests = requests
  still waiting on the host (B9). All = every booking the page lists today.
- Event type: only the host's own; an unknown id matches nothing.
- From / To: dates in the host's time zone, both inclusive, compared with the booking's start date there. A date that
  isn't a real YYYY-MM-DD is ignored. From after To: swapped.
- As today: holds that lapsed unpaid are left out, and a request that ran out is left out.
- Order as today: upcoming first (soonest first), then past (latest first).

## CSV
- Columns: Date, Start, End, Time zone, Event type, Guest name, Guest email, Phone, Extra guests, Status, No-show,
  Cancelled by, Cancel reason, Booked on. Times in the host's time zone, 24-hour.
- Booking answers and private client notes are left out: they can hold sensitive details, and the host sees them on
  each booking.
- Cells a spreadsheet would read as a formula are guarded (the shared csvCell).
- File name: `bookings-<YYYY-MM-DD>.csv` (today in the host's zone). `cache-control: no-store`.
- Like the other downloads, on the Solo, Duo and Clinic plans (the plan's existing `reportExport`). Free hosts see the
  search and filters, and a line that downloads are on Solo and Duo. No plan or price changes.
- Only the account owner downloads: a Duo second person managing someone's bookings can search them but sees no
  download, since a download takes the whole client list off Hourhand.

## Tests
- Search by name, email, extra guest, phone digits; case and spaces ignored; under 3 digits doesn't phone-match.
- Each Show value; event type filter; from/to inclusive in the host's zone (a booking at 23:30 IST on the 5th is the
  5th); swapped dates; bad dates ignored; lapsed holds and lapsed requests left out.
- Query parsing from URL params, including `show=requests`, and the query string round-trip for the download link.
- CSV: header, a row's values in the host's zone, formula guard, extra guests joined, status words.
- Route: 401 signed out, 403 on the free plan, 403 while acting for someone else, CSV otherwise.
