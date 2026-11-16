-- Roadmap 3.5, session prep: a short AI brief before each session, from the client's booking answers and session
-- history. Off until the host turns it on. One row per booking whatever the outcome, so a booking is sent at most once.
create table session_prep_settings (
  user_id uuid primary key references users(id) on delete cascade,
  enabled boolean not null default false,
  enabled_at timestamptz,                      -- when the host agreed to the disclosure and turned it on
  updated_at timestamptz not null default now()
);

create table session_briefs (
  booking_id uuid primary key references bookings(id) on delete cascade,
  host_id uuid not null references users(id) on delete cascade,
  status text not null check (status in ('ready','skipped','failed')),
  brief text check (length(brief) <= 1200),
  reason text,                                 -- why it was skipped or failed
  model text,
  input_tokens int,
  output_tokens int,
  created_at timestamptz not null default now(),
  check ((status = 'ready') = (brief is not null))
);
create index session_briefs_host_month_idx on session_briefs (host_id, created_at);
