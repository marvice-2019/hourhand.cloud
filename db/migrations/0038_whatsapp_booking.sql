-- 3.4: book over WhatsApp. A client messages Hourhand's one number ("Book with priya"), gets the host's event types
-- and next free times as interactive lists, then a link to the booking page with that time. Nothing is booked here.

-- Hosts who chose to be offered on WhatsApp. No row = never offered, whatever the plan.
create table whatsapp_booking_hosts (
  user_id uuid primary key references users(id) on delete cascade,
  enabled_at timestamptz not null default now()
);

-- Where one phone's conversation is: only what routing needs, never message text. Rows older than a day are deleted
-- (the service window is 24 hours, so nothing older can be answered anyway).
create table whatsapp_booking_sessions (
  phone text primary key,                     -- digits with country code, as WhatsApp sends it
  host_id uuid references users(id) on delete cascade,
  event_type_id uuid references event_types(id) on delete set null,
  timezone text,
  step text not null check (step in ('ask_host', 'pick_event', 'pick_slot', 'pick_zone', 'sent_link')),
  last_message_id text,                       -- Meta can deliver a message twice; the second is ignored
  updated_at timestamptz not null default now()
);
create index whatsapp_booking_sessions_updated_at on whatsapp_booking_sessions (updated_at);

-- Daily counts only, for cost and funnel: messages in, replies out, booking links sent. Not per phone.
create table whatsapp_booking_counts (
  day date not null,
  host_id uuid references users(id) on delete cascade,
  inbound int not null default 0,
  replies int not null default 0,
  links int not null default 0
);
create unique index whatsapp_booking_counts_host on whatsapp_booking_counts (day, host_id) where host_id is not null;
create unique index whatsapp_booking_counts_unrouted on whatsapp_booking_counts (day) where host_id is null;
