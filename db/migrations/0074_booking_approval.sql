-- B9: booking requests the host approves (docs/specs/B9-approval.md). An event type can ask for the host's approval; its
-- bookings start as pending_approval and hold the slot until hold_expires_at, exactly like a payment hold.
alter table event_types add column requires_approval boolean not null default false;

alter table bookings drop constraint bookings_status_check;
alter table bookings add constraint bookings_status_check check (status in ('confirmed','cancelled','pending_payment','pending_approval'));
alter table bookings drop constraint bookings_hold_check;
alter table bookings add constraint bookings_hold_check check ((status in ('pending_payment','pending_approval')) = (hold_expires_at is not null));

-- A request blocks the host's calendar like a confirmed booking or a payment hold.
alter table bookings drop constraint no_double_booking;
alter table bookings add constraint no_double_booking exclude using gist
  (host_id with =, busy with &&, (coalesce(class_key, id::text)) with <>) where (status in ('confirmed','pending_payment','pending_approval'));

-- The Requests filter and the lapse sweep look these up.
create index bookings_pending_approval_idx on bookings (host_id, hold_expires_at) where status = 'pending_approval';

-- Only a free one-on-one event type without weekly repeats asks for approval (the editor explains why; this backs it up).
alter table event_types add constraint event_types_approval_scope check
  (not requires_approval or (price_minor is null and deposit_minor is null and kind = 'one_on_one' and max_repeats = 1));
