-- Roadmap 1.4 part B: guests pay Stripe-connected hosts through Stripe Checkout on the host's own account (direct
-- charges). A Stripe payment's provider_order_id is the Checkout Session id and provider_payment_id the PaymentIntent.
-- Prices carry their currency: INR for Razorpay hosts, the Stripe account's currency otherwise.

-- The Checkout page a held booking or purchase pays on, so a retried request sends the guest back to the same session.
alter table payments add column checkout_url text;
-- Hourhand's cut on a Stripe payment, fixed when the session is made (0 for now), so a refund knows whether to return it.
alter table payments add column application_fee_minor int not null default 0 check (application_fee_minor >= 0);

-- Deposits now carry a currency too (it was implied INR). Any three-letter currency, since Stripe accounts settle in many.
update event_types set currency = 'INR' where currency is null and deposit_minor is not null;
alter table event_types drop constraint event_types_check;
alter table event_types add constraint event_types_currency_set check ((currency is null) = (price_minor is null and deposit_minor is null));
alter table event_types drop constraint event_types_currency_check;
alter table event_types add constraint event_types_currency_check check (currency ~ '^[A-Z]{3}$');

alter table packages drop constraint packages_currency_check;
alter table packages add constraint packages_currency_check check (currency ~ '^[A-Z]{3}$');

alter table package_purchases add column provider text not null default 'razorpay' check (provider in ('razorpay', 'stripe'));
alter table package_purchases add column checkout_url text;
alter table package_purchases add column application_fee_minor int not null default 0 check (application_fee_minor >= 0);
alter table package_purchases add constraint package_purchases_currency_check check (currency ~ '^[A-Z]{3}$');

-- The Stripe reconciler and the Connect webhook find a payment by its session.
create index payments_stripe_pending_idx on payments (checked_at nulls first, created_at) where provider = 'stripe' and status = 'pending';
