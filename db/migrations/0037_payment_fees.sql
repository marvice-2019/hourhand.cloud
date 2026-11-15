-- Razorpay's own fee on each captured payment, so reports show what the gateway really charged instead of an estimate.
-- fee_minor is the whole fee including GST; fee_tax_minor is the GST part (Razorpay's `fee` and `tax`, in paise).
-- Recorded at capture when Razorpay returns it; otherwise a background job fetches it later, at most hourly per row
-- (fee_checked_at). Null means not known yet: reports estimate those rows and say so.
alter table payments add column fee_minor int check (fee_minor >= 0);
alter table payments add column fee_tax_minor int check (fee_tax_minor >= 0 and fee_tax_minor <= fee_minor);
alter table payments add column fee_checked_at timestamptz;
alter table package_purchases add column fee_minor int check (fee_minor >= 0);
alter table package_purchases add column fee_tax_minor int check (fee_tax_minor >= 0 and fee_tax_minor <= fee_minor);
alter table package_purchases add column fee_checked_at timestamptz;

-- The fee job looks only at captured Razorpay money whose fee isn't known yet.
create index payments_fee_due_idx on payments (fee_checked_at nulls first)
  where fee_minor is null and provider = 'razorpay' and provider_payment_id is not null and status in ('paid', 'refund_pending', 'refunded');
create index package_purchases_fee_due_idx on package_purchases (fee_checked_at nulls first)
  where fee_minor is null and status = 'paid';
