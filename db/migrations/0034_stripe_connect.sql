-- Roadmap 1.4: hosts outside India take payment through their own Stripe account (Stripe Connect, full Stripe Dashboard,
-- Stripe collects fees and losses: the Accounts v2 form of a Standard account). Hourhand stores only the account id,
-- sealed and bound to its owner like the Razorpay keys; nothing Stripe-side is secret, but the seal stops a row being
-- moved to another host. public_id holds the id in the clear for webhook lookups (it is not a credential).
alter table integrations add column onboarding text check (onboarding in ('pending', 'active', 'restricted'));
alter table integrations add column currency text check (currency ~ '^[A-Z]{3}$');
alter table integrations add column country text check (country ~ '^[A-Z]{2}$');
alter table integrations add constraint integrations_stripe_shape
  check (provider <> 'stripe' or (public_id is not null and onboarding is not null));
-- Webhooks name the connected account; find its host without scanning.
create unique index integrations_stripe_account_idx on integrations (public_id) where provider = 'stripe';
-- A host takes payments through one provider at a time. Switching means disconnecting the other first, which is refused
-- while a guest's payment is still being confirmed or refunded.
create unique index integrations_one_payment_provider on integrations (user_id) where provider in ('razorpay', 'stripe');
