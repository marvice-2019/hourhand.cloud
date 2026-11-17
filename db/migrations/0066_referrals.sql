-- Roadmap 3.8: host referrals. A host shares hourhand.cloud/r/<code>; when someone signs up through it and pays for
-- Solo or Duo, both get a free month (one month of Solo) at their next renewal. Credits are never paid out as cash.

-- One random code per host (not their slug, so a link can't be guessed from a booking page).
create table referral_codes (
  user_id uuid primary key references users(id) on delete cascade,
  code text not null unique check (code ~ '^[a-z0-9]{10}$'),
  created_at timestamptz not null default now()
);

-- "Invited": browsers that opened a host's link, counted once per browser.
create table referral_clicks (
  referrer_id uuid not null references users(id) on delete cascade,
  device_id text not null,
  clicked_at timestamptz not null default now(),
  primary key (referrer_id, device_id)
);

-- Browsers each host has used (from the hh_dev cookie), for the "same device within 30 days" self-referral rule.
create table referral_devices (
  user_id uuid not null references users(id) on delete cascade,
  device_id text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- One referral per new account (referred_id is unique). blocked: a self-referral rule matched; kept for support.
-- capped: the referred host paid, but the referrer already had 12 rewarded referrals in the last 12 months.
create table referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references users(id) on delete cascade,
  referred_id uuid not null unique references users(id) on delete cascade,
  status text not null default 'signed_up' check (status in ('signed_up', 'rewarded', 'capped', 'blocked')),
  blocked_reason text check (blocked_reason in ('same_email', 'same_device', 'same_payment_method')),
  signed_up_at timestamptz not null default now(),
  paid_at timestamptz,
  payment_ref text,                         -- the provider's payment or invoice id that triggered the reward
  check (referrer_id <> referred_id)
);
create index referrals_referrer_idx on referrals (referrer_id, status, paid_at);

-- A free month owed to one host. pending: not yet handed to the payment provider (no paid plan yet, or one already
-- queued for this cycle). scheduled: the provider will take it off the next renewal. used: that renewal was charged.
-- extension: the provider can't discount this subscription (Razorpay UPI AutoPay / eMandate), so it is a month of Solo
-- added after the paid plan ends (access_from / access_until are set when it does). failed: the provider refused; see error.
create table referral_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  referral_id uuid not null references referrals(id) on delete cascade,
  role text not null check (role in ('referrer', 'referred')),
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'used', 'extension', 'failed')),
  mechanism text check (mechanism in ('stripe_balance', 'razorpay_offer', 'extension')),
  provider_subscription_id text,
  provider_ref text,
  scheduled_at timestamptz,
  access_from timestamptz,
  access_until timestamptz,
  error text,
  missed_renewals int not null default 0,   -- renewals charged in full although the offer was linked (Razorpay didn't apply it)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (referral_id, role)
);
create index referral_credits_user_idx on referral_credits (user_id, status);
