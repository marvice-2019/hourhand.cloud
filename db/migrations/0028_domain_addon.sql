-- The custom-domain add-on (Rs 199/month + GST): a provider subscription of its own, next to the host's plan
-- subscription. A host's domain serves only while this is live AND the host is on a paid plan.
create table addon_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  addon text not null check (addon in ('domain')),
  provider text not null check (provider in ('razorpay','stripe')),
  provider_subscription_id text not null unique,
  provider_customer_id text,
  provider_status text,
  status text not null check (status in ('active','paused','past_due','unpaid','cancelled')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, addon)
);
