-- Ask a question (B19, like Topmate's Priority DM): a guest pays the host (or asks free, if the host allows) to send one
-- written question, and gets the host's written answer by email. One offer per host, off until the host turns it on.
create table question_offers (
  host_id uuid primary key references users(id) on delete cascade,
  active boolean not null default false,
  price_minor integer not null default 0 check (price_minor >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  response_days integer not null default 3 check (response_days between 1 and 14),
  intro text check (length(intro) <= 500),
  updated_at timestamptz not null default now()
);

-- open: waiting for the host's answer (paid, or free). pending: waiting for payment. failed: never paid.
-- declined: the host turned down a free question. refund_pending/refunded: the host turned down a paid one.
create table questions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),  -- the guest's private link (/q/<token>)
  idempotency_key text not null,
  guest_name text not null check (length(guest_name) between 1 and 100),
  guest_email citext not null,
  question text not null check (length(question) between 1 and 2000),
  price_minor integer not null check (price_minor >= 0),
  currency text not null default 'INR',
  due_at timestamptz,
  status text not null check (status in ('pending', 'open', 'answered', 'declined', 'failed', 'refund_pending', 'refunded')),
  provider text check (provider in ('razorpay')),
  provider_order_id text,
  provider_payment_id text,
  collected_via text not null default 'host' check (collected_via in ('host', 'platform')),
  commission_minor integer not null default 0 check (commission_minor >= 0),
  transfer_account text,
  answer text check (length(answer) <= 5000),
  answered_at timestamptz,
  declined_at timestamptz,
  refund_id text,
  paid_at timestamptz,
  checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (host_id, idempotency_key)
);
create index questions_host_idx on questions (host_id, created_at desc);
create index questions_due_idx on questions (checked_at nulls first, created_at) where status in ('pending', 'refund_pending');
