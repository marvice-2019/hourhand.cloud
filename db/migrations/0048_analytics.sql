-- First-party booking analytics: which channels bring each host's bookings. No cookies, no IP addresses, no user
-- agents. A visitor is a hash of (today's salt, address, browser, host); the salt lives in analytics_salts only for
-- its own day and is deleted once the day is over, so yesterday's hashes can't be linked to anyone, or to today's.
--
-- Raw rows are kept 90 days, then only the per-day totals in analytics_daily (kept 2 years). The rollup job
-- (src/lib/analytics/store.ts) moves finished days into analytics_daily and prunes both tables.

create table analytics_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  -- No foreign key: deleting an event type keeps its history (shown as a deleted event type), and a set-null would
  -- collide with the de-dup index below. Null = the host's profile page.
  event_type_id uuid,
  kind text not null check (kind in ('view', 'slot_click', 'booking_started', 'booking_created')),
  day date not null,
  -- 32 hex characters; null only for booking_created, which is unique by booking instead.
  visitor_hash text check (visitor_hash is null or visitor_hash ~ '^[0-9a-f]{32}$'),
  booking_id uuid,
  channel text not null check (channel ~ '^[a-z_]{1,20}$'),
  utm_source text not null default '' check (length(utm_source) <= 100),
  utm_medium text not null default '' check (length(utm_medium) <= 100),
  utm_campaign text not null default '' check (length(utm_campaign) <= 100),
  ref_domain text not null default '' check (length(ref_domain) <= 253),
  embed boolean not null default false,
  created_at timestamptz not null default now(),
  check ((kind = 'booking_created') = (booking_id is not null)),
  check (kind = 'booking_created' or visitor_hash is not null)
);

create index analytics_events_user_day on analytics_events (user_id, day);
create index analytics_events_day on analytics_events (day);
-- One count per visitor, page (event type) and step a day; a booking is counted once however often its request repeats.
create unique index analytics_events_dedupe on analytics_events
  (user_id, day, kind, coalesce(event_type_id, '00000000-0000-0000-0000-000000000000'::uuid), visitor_hash) where visitor_hash is not null;
create unique index analytics_events_booking on analytics_events (booking_id) where booking_id is not null;

create table analytics_daily (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  event_type_id uuid,
  channel text not null,
  utm_source text not null default '',
  utm_medium text not null default '',
  utm_campaign text not null default '',
  ref_domain text not null default '',
  embed boolean not null default false,
  views integer not null default 0 check (views >= 0),
  slot_clicks integer not null default 0 check (slot_clicks >= 0),
  started integer not null default 0 check (started >= 0),
  completed integer not null default 0 check (completed >= 0)
);

create index analytics_daily_user_day on analytics_daily (user_id, day);
create index analytics_daily_day on analytics_daily (day);

-- Days already moved into analytics_daily; their raw rows are no longer read.
create table analytics_rollups (
  day date primary key,
  rolled_at timestamptz not null default now()
);

-- Only the current day's salt is ever kept.
create table analytics_salts (
  day date primary key,
  salt bytea not null check (length(salt) = 32)
);
