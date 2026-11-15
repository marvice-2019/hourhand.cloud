-- 2.6: after a session ends, the guest gets one follow-up email that helps the host get rebooked and reviewed.
-- Settings live per event type in their own table; no row means every follow-up is off, so existing event types send
-- nothing after this deploys.
create table follow_up_settings (
  event_type_id uuid primary key references event_types(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  thank_you boolean not null default false,       -- thank-you line and a one-tap link to book the same event type again
  feedback boolean not null default false,        -- 1 to 5 rating and an optional comment, private to the host
  review_ask boolean not null default false,      -- the host's Google review link (from their profile), offered to everyone
  package_nudge boolean not null default false,   -- "1 session left" / "all used" with a link to buy the package again
  delay_hours int not null default 2 check (delay_hours in (1, 2, 24)),
  updated_at timestamptz not null default now()
);
create index follow_up_settings_user_idx on follow_up_settings (user_id);

-- A guest who said "no more follow-ups" from this host. Booking emails (confirmations, reminders) still go.
create table follow_up_opt_outs (
  host_id uuid not null references users(id) on delete cascade,
  email citext not null,
  opted_out_at timestamptz not null default now(),
  primary key (host_id, email)
);

-- One answer per booking (a group class seat is its own booking). The primary key is what makes a feedback link single-use.
create table booking_feedback (
  booking_id uuid primary key references bookings(id) on delete cascade,
  host_id uuid not null references users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (length(comment) <= 2000),   -- plain text, escaped wherever it is shown
  created_at timestamptz not null default now()
);
create index booking_feedback_host_idx on booking_feedback (host_id, created_at desc);
