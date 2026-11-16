-- Meeting polls: a host proposes 2 to 8 times for one meeting and shares one link. Invitees (no account) vote yes,
-- if-needed or no on each time; the host confirms one, which books it for everyone who said yes or if-needed.
-- While a poll is open its times are held (blocked from other bookings) unless the host chose not to hold them.
create table polls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null check (length(title) between 1 and 100),
  description text check (length(description) <= 2000),
  duration_minutes int not null check (duration_minutes between 5 and 720),
  location_kind text not null,
  location_value text,
  token text not null unique,                    -- the shared voting link (/v/<token>); public by design, like a group invite
  hold_times boolean not null default true,      -- block the proposed times from other bookings while open
  deadline timestamptz not null,                 -- votes close here; the host is emailed to pick
  status text not null default 'open' check (status in ('open','closed','confirmed','cancelled')),
  closed_at timestamptz,
  confirmed_start timestamptz,
  event_type_id uuid references event_types(id) on delete set null,   -- the hidden one-off type made on confirm
  created_at timestamptz not null default now(),
  check ((status = 'confirmed') = (confirmed_start is not null))
);
create index polls_user_idx on polls (user_id, created_at);
create index polls_due_idx on polls (deadline) where status = 'open';

create table poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  unique (poll_id, start_at),
  check (end_at > start_at)
);

create table poll_voters (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  email citext not null,
  phone text,
  timezone text not null,
  locale text not null default 'en',
  booking_id uuid references bookings(id) on delete set null,          -- their booking once the host confirmed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (poll_id, email)                                               -- one vote set per email
);

create table poll_votes (
  voter_id uuid not null references poll_voters(id) on delete cascade,
  option_id uuid not null references poll_options(id) on delete cascade,
  answer text not null check (answer in ('yes','if_needed','no')),
  primary key (voter_id, option_id)
);
create index poll_votes_option_idx on poll_votes (option_id);
