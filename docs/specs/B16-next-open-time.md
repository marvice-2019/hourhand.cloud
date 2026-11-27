# B16: jump to the next open time

Calendly, Cal.com and Zoho Bookings move a guest straight to the first month with open times. On Hourhand a month
with none said "No open times this month" and offered "Show next month", so a guest booking a host whose next
opening is weeks away paged through empty months, or gave up thinking the host was fully booked.

## Guest
- A month with no open times names the first open time after it, as its date and time in the zone the guest is
  viewing, with a "Go to that day" button that opens that month with the day picked and its times listed.
- When nothing is left in the booking window it says "No open times are left to book right now" and hides
  "Show next month", which would only open more empty months.
- When the next time isn't known (the request asked for none, or the month's only times fell on the last day of the
  month before, in the guest's zone), the page keeps "Show next month" as before.
- New strings in all nine guest languages; the eight non-English lines are drafts for native-speaker review, as the
  rest of that file.

## API
- GET /api/slots takes `next=1`. When the range has no open times, the reply adds `next`: the first open time at
  or after the range's end, or null when none is left. A range with times, or a request without `next=1`, gets no
  `next` field, so other callers see no change.
- The look-ahead runs the same slot engine as the range itself (same length, same booking being moved), one 62-day
  slice at a time, and stops at the first slice with a time. It ends at the booking window, or at a one-off
  meeting's last time. An out-of-date calendar hides every time, so it answers null without looking.

## Tests
- An empty range with next=1 names the same time a request for the days after it lists first; without next=1, or
  with times in range, there's no `next`; a closed booking window gives null.
- nextOpenTime agrees with a plain scan of a 120-day window from six starting points, across the 62-day slice edge.
- A one-off meeting finds its later time past the booking window, and null after its last time.
