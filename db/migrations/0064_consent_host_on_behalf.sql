-- The consent log learns one more channel: host_on_behalf, a booking the host (or their Duo second person) made for
-- the client from the dashboard. The client saw nothing, so the log records the host's act, not the client's consent.
-- Additive: existing rows all satisfy the wider check.
alter table consent_records drop constraint consent_records_channel_check;
alter table consent_records add constraint consent_records_channel_check
  check (channel in ('booking_page', 'single_use_link', 'package_link', 'host_on_behalf'));
