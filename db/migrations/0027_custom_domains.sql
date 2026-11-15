-- Custom domains (roadmap 1.1): one booking domain per host, e.g. book.coachname.com, verified by DNS before it serves.
-- status: pending until the first DNS check passes, active once it has, failed when a check finds the record gone or
-- pointing elsewhere (last_error says why). Only an active domain on an entitled host serves pages.
create table custom_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  domain citext not null unique check (length(domain) between 4 and 253 and domain::text ~ '^[a-z0-9.-]+$'),
  status text not null default 'pending' check (status in ('pending','active','failed')),
  last_checked_at timestamptz,
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The scheduled re-check picks the domains checked longest ago first.
create index custom_domains_last_checked on custom_domains (last_checked_at nulls first);
