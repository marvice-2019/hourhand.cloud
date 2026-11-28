-- How each host's guests pay (B18). 'own' (the default, and every existing host) keeps today's behaviour: guests pay the
-- host's own Razorpay or Stripe. A super admin can move a host to:
--   split     guests pay Hourhand's Razorpay; Razorpay Route sends the host's share to their linked account at once and
--             Hourhand keeps the commission
--   platform  guests pay Hourhand's Razorpay; Hourhand owes the host their share and records each payout by hand
-- commission_bps overrides the platform default for one host (basis points: 1000 = 10%).
alter table users
  add column payment_mode text not null default 'own' check (payment_mode in ('own', 'split', 'platform')),
  add column commission_bps integer check (commission_bps between 0 and 10000),
  add column route_account_id text check (route_account_id ~ '^acc_[A-Za-z0-9]{6,32}$');

-- Hourhand's own payment gateway, sealed with TOKEN_ENCRYPTION_KEY like hosts' keys. Only the key id is in the clear.
create table platform_gateways (
  provider text primary key check (provider in ('razorpay')),
  credentials_encrypted bytea not null,
  public_id text not null,
  mode text not null check (mode in ('test', 'live')),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- Which account took each payment, fixed when its order is made, so confirming and refunding it later uses the same
-- account even after the host's mode changes. commission_minor is Hourhand's share; transfer_account is the host's
-- Route account when the payment was split.
alter table payments
  add column collected_via text not null default 'host' check (collected_via in ('host', 'platform')),
  add column commission_minor integer not null default 0 check (commission_minor >= 0),
  add column transfer_account text;
alter table package_purchases
  add column collected_via text not null default 'host' check (collected_via in ('host', 'platform')),
  add column commission_minor integer not null default 0 check (commission_minor >= 0),
  add column transfer_account text;

-- Money Hourhand paid out to hosts whose guests paid Hourhand ('platform' mode), recorded by a super admin.
create table host_payouts (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null default 'INR',
  reference text not null check (length(reference) between 1 and 200),
  paid_at timestamptz not null default now(),
  recorded_by uuid references users(id) on delete set null
);
create index host_payouts_host_idx on host_payouts (host_id, paid_at desc);
