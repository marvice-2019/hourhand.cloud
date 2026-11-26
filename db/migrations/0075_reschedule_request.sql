-- B10: the host asks the guest to pick a new time (docs/specs/B10-ask-to-reschedule.md). The booking stays as it is
-- until the guest moves it; these say when the host asked and what they wrote.
alter table bookings add column reschedule_requested_at timestamptz;
alter table bookings add column reschedule_request_note text;
alter table bookings add constraint bookings_reschedule_note_len check (reschedule_request_note is null or char_length(reschedule_request_note) <= 500);
