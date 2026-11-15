-- AI phone receptionist (paid add-on on Duo and Clinic). A host's own voice agent (ElevenLabs Agents) answers their
-- number, reads the host's public info, offers free times and books them through Hourhand's voice tools API
-- (/api/voice/tools/*), or takes a message for the host. Nothing here is secret: each host's tool key is derived from
-- VOICE_TOOLS_KEY and the host's key_version, so rotating a key is just bumping key_version.

create table voice_settings (
  host_id uuid primary key references users(id) on delete cascade,
  enabled boolean not null default false,
  -- Bumped to revoke every tool key handed out before (the agent must be given the new one).
  key_version integer not null default 1 check (key_version >= 1),
  -- Hard stop: once this month's call minutes reach it, calls are answered with one line and ended, and tools refuse.
  monthly_minute_cap integer not null default 100 check (monthly_minute_cap between 0 and 20000),
  -- Calls are not recorded unless the host turns this on; the agent then tells every caller at the start.
  recording_enabled boolean not null default false,
  -- What the host lets the assistant tell any caller: address, landmark, parking, languages spoken. Public by intent;
  -- the booking pages don't show addresses before booking, so the assistant only reads this.
  public_note text not null default '' check (length(public_note) <= 1000),
  -- The host's ElevenLabs agent and the number it answers (E.164), filled in during setup.
  agent_id text unique check (agent_id is null or agent_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  phone_number text check (phone_number is null or phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  -- The calendar month (YYYY-MM, host's zone) whose 80% warning email already went, so it goes once a month.
  cap_warned_month text check (cap_warned_month is null or cap_warned_month ~ '^[0-9]{4}-[0-9]{2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per call. A row is opened by the first tool call (or the call-start webhook) and closed by the post-call
-- webhook, which sets the duration and cost. Transcripts and audio are not stored here.
create table voice_calls (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  conversation_id text not null unique check (conversation_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  caller_phone text check (caller_phone is null or length(caller_phone) <= 20),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_secs integer not null default 0 check (duration_secs >= 0),
  -- What Hourhand pays for the call (agent + telephony), in paise, at the rates in src/lib/voice/cost.ts.
  cost_paise integer not null default 0 check (cost_paise >= 0),
  outcome text not null default 'in_progress'
    check (outcome in ('in_progress', 'booked', 'payment_link', 'message', 'handoff', 'info', 'cap_reached', 'no_action')),
  -- Failed tool attempts on this call (no slot, slot taken, bad input). The second one hands the caller off.
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  booking_id uuid references bookings(id) on delete set null,
  created_at timestamptz not null default now()
);
create index voice_calls_host_started on voice_calls (host_id, started_at desc);

-- Messages the agent took for the host: on request, on a handoff, or for anything it can't handle.
create table voice_messages (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  call_id uuid references voice_calls(id) on delete set null,
  caller_name text not null check (length(caller_name) between 1 and 100),
  caller_phone text not null check (length(caller_phone) between 1 and 20),
  body text not null check (length(body) between 1 and 2000),
  reason text not null check (reason in ('requested', 'handoff', 'out_of_scope', 'payment_issue', 'low_confidence', 'other')),
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index voice_messages_host_created on voice_messages (host_id, created_at desc);

-- Where a booking came from. Everything before this was made on the booking pages.
alter table bookings add column source text not null default 'web' check (source ~ '^[a-z_]{1,20}$');

-- The receptionist is sold as an add-on, billed like the custom domain (src/lib/billing/addons.ts).
alter table addon_subscriptions drop constraint addon_subscriptions_addon_check;
alter table addon_subscriptions add constraint addon_subscriptions_addon_check check (addon in ('domain', 'voice'));
