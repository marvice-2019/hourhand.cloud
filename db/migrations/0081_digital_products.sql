-- Digital products (B20, like Topmate's): a host sells a file, or a link shown after payment. Guests buy at
-- /<slug>/shop/<product>, pay the host (or Hourhand under B18) or get it free, and download from /d/<token>.
create table digital_products (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
  title text not null check (length(title) between 1 and 120),
  description text check (length(description) <= 2000),
  price_minor integer not null default 0 check (price_minor >= 0 and price_minor <= 10000000),
  currency text not null default 'INR' check (currency = 'INR'),
  delivery text not null default 'file' check (delivery in ('file', 'link')),
  link_url text check (link_url is null or (link_url like 'https://%' and length(link_url) <= 500)),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (host_id, slug)
);

-- One file per product, kept in the database like profile photos (single server; backups include it).
create table product_files (
  product_id uuid primary key references digital_products(id) on delete cascade,
  filename text not null check (length(filename) between 1 and 200),
  mime text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  data bytea not null,
  sha256 text not null,
  updated_at timestamptz not null default now()
);

-- pending: waiting for payment. paid: the buyer can download. failed: never paid.
-- refund_pending/refunded: the host refunded a paid order (the download stops at once).
create table product_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references digital_products(id) on delete cascade,
  host_id uuid not null references users(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  idempotency_key text not null,
  buyer_name text not null check (length(buyer_name) between 1 and 100),
  buyer_email citext not null,
  price_minor integer not null check (price_minor >= 0),
  currency text not null default 'INR',
  status text not null check (status in ('pending', 'paid', 'failed', 'refund_pending', 'refunded')),
  provider text check (provider in ('razorpay')),
  provider_order_id text,
  provider_payment_id text,
  collected_via text not null default 'host' check (collected_via in ('host', 'platform')),
  commission_minor integer not null default 0 check (commission_minor >= 0),
  transfer_account text,
  refund_id text,
  paid_at timestamptz,
  refunded_at timestamptz,
  checked_at timestamptz,
  last_error text,
  download_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, idempotency_key)
);
create index product_orders_host_idx on product_orders (host_id, created_at desc);
create index product_orders_due_idx on product_orders (checked_at nulls first, created_at) where status in ('pending', 'refund_pending');
