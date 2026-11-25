-- Outgoing webhooks (Calendly, Cal.com, Zoho Bookings and TidyCal have them): a host sends their bookings to their own
-- automation (n8n, Zapier, Make, a CRM). Each delivery is queued in the same transaction as the booking change, so none
-- is lost and none goes for a change that rolled back, then sent by the job runner with retries (src/lib/webhooks).
create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  url text not null check (url ~ '^https://' and length(url) <= 500),
  secret_sealed bytea not null,                       -- the signing key, sealed with TOKEN_ENCRYPTION_KEY
  events text[] not null check (cardinality(events) between 1 and 3
    and events <@ array['booking.created', 'booking.cancelled', 'booking.rescheduled']),
  active boolean not null default true,
  last_status int,                                    -- HTTP status of the last attempt (null: no answer)
  last_error text,
  last_delivery_at timestamptz,
  created_at timestamptz not null default now()
);
create index on webhook_endpoints (user_id);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  event text not null,
  payload jsonb not null,                             -- what is sent, fixed when the change happened
  dedupe_key text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  last_status int,
  last_error text,
  created_at timestamptz not null default now(),
  unique (endpoint_id, dedupe_key)
);
create index on webhook_deliveries (next_at) where status = 'queued';
