-- Roadmap 3.9 (B): the practice page's services and the shared waitlist.
--
-- A service ("Individual therapy, 50 min") is the practice's own name for what several practitioners offer. Each
-- practitioner links their own event types to it; the event types stay theirs (hours, price, booking link). The
-- practice page lists each service with the practitioners who offer it, and clients choose who they book.
--
-- The shared waitlist is per service and day: when any practitioner's booking for that service frees a time on that
-- day, everyone waiting is emailed once with a link to that practitioner's freed time. Whoever books first gets it.

create table practice_services (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references practices(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  slug citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  description text check (length(description) <= 1000),
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (practice_id, slug)
);

-- Which practitioner event types offer a service. An event type offers one service at most.
create table practice_service_event_types (
  service_id uuid not null references practice_services(id) on delete cascade,
  event_type_id uuid not null unique references event_types(id) on delete cascade,
  primary key (service_id, event_type_id)
);

create table practice_waitlist (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references practices(id) on delete cascade,
  service_id uuid not null references practice_services(id) on delete cascade,
  day date not null,                       -- the day as the guest saw it
  timezone text not null,
  window_start timestamptz not null,       -- that day's bounds in their zone
  window_end timestamptz not null,
  name text not null check (length(name) between 1 and 100),
  email citext not null,
  notified_at timestamptz,                 -- set when their one email is queued
  created_at timestamptz not null default now(),
  unique (service_id, day, email),
  check (window_end > window_start)
);
create index practice_waitlist_waiting_idx on practice_waitlist (service_id, window_start) where notified_at is null;
create index practice_waitlist_email_idx on practice_waitlist (email, created_at);
