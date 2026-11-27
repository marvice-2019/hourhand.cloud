-- B14: personal API keys for the read API (/api/v1). Calendly, Cal.com, Zoho Bookings and TidyCal give hosts an API.
-- Only a SHA-256 hash of each key is kept, so a key is shown once when made and never again; `prefix` (its first
-- characters) tells the host's keys apart. Removing a key deletes its row.
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  prefix text not null,
  key_hash bytea not null unique check (length(key_hash) = 32),
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index api_keys_user on api_keys (user_id, created_at);
