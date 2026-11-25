-- Phone alerts: a host turns them on in Settings on each phone or computer they want them on. The browser hands us a
-- push address at its own push service (Google, Mozilla, Apple or Microsoft) and two keys to encrypt messages with.
-- New, moved and cancelled bookings then go out on the 'push' channel of the notifications outbox.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- One row per browser: a browser that a second account turns alerts on in moves to that account.
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{40,200}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{10,100}$'),
  device text check (char_length(device) <= 120),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);
create index push_subscriptions_user_id_idx on push_subscriptions (user_id, created_at);

alter table notifications drop constraint notifications_channel_check;
alter table notifications add constraint notifications_channel_check check (channel in ('email','whatsapp','sms','calendar','payment','video','push'));
