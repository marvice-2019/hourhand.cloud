-- Weekly repeats on priced event types. The guest pays for every week of the series in one payment, held by the
-- series' first booking (bookings.series_id). Cancelling some weeks refunds their share (amount / sessions each);
-- cancelling them all refunds the whole payment as before. A no-show deposit still holds one booking only.
alter table event_types drop constraint event_types_repeat_free;
alter table event_types add constraint event_types_repeat_free check (max_repeats = 1 or deposit_minor is null);

-- How many sessions the payment covers (1 for every payment so far), and the part of it queued for a refund but not
-- yet refunded. refunded_minor stays what has been refunded so far.
alter table payments add column sessions int not null default 1 check (sessions between 1 and 12);
alter table payments add column refund_due_minor int not null default 0 check (refund_due_minor >= 0);
alter table payments add constraint payments_refunds_within_amount check (refunded_minor + refund_due_minor <= amount_minor);
alter table payments add constraint payments_series_split check (sessions = 1 or (kind = 'payment' and amount_minor % sessions = 0));
create index payments_refund_due_idx on payments (checked_at nulls first) where status = 'paid' and refund_due_minor > 0;

-- Each partial refund (some weeks of a series), so earnings can place it in the month it was made. A refund that
-- completes the payment is recorded on the payment itself, as before (status refunded, refunded_at).
create table payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  amount_minor int not null check (amount_minor > 0),
  provider_refund_id text,
  refunded_at timestamptz not null
);
create index on payment_refunds (payment_id);

-- A series refunded a few weeks at a time gets a credit note per refund, so one invoice can have several.
drop index invoices_one_credit_note;
create index invoices_credit_notes_idx on invoices (original_invoice_id) where kind = 'credit_note';
