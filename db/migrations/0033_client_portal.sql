-- 3.2 Client portal: a client of a host signs in with an emailed link (no password) and gets a session scoped to that
-- host and that email. Only hashes of the link nonce and the session id are stored, so a database dump opens nothing.

create table portal_links (
  nonce_hash text primary key,                 -- sha256 of the random nonce in the emailed link
  host_id uuid not null references users(id) on delete cascade,
  email citext not null,
  expires_at timestamptz not null,             -- 15 minutes after it was sent
  used_at timestamptz,                         -- single use: set by the one request that opens it
  created_at timestamptz not null default now()
);
create index portal_links_expires_idx on portal_links (expires_at);

create table portal_sessions (
  id_hash text primary key,                    -- sha256 of the cookie value
  host_id uuid not null references users(id) on delete cascade,
  email citext not null,
  expires_at timestamptz not null,             -- 30 days after sign-in
  created_at timestamptz not null default now()
);
create index portal_sessions_expires_idx on portal_sessions (expires_at);
