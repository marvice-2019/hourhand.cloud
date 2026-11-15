-- Roadmap 3.10, part 2: client rights. Hosts (data fiduciaries) can export or erase one client's data, and a guest can
-- ask their host for either from their booking's manage link. Additive only.

-- Each erasure: who did it and when. Never what or whom: no email, name or client key is kept here.
create table client_erasures (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  erased_at timestamptz not null default now()
);
create index client_erasures_host_idx on client_erasures (host_id, erased_at);

-- CGST Rule 56(8): a change to an electronic record keeps a log. When an erasure anonymises an issued invoice's buyer
-- details, the fields changed (not their values) are logged here against the invoice.
create table invoice_redactions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  erasure_id uuid not null references client_erasures(id) on delete cascade,
  fields text[] not null check (cardinality(fields) > 0),
  redacted_at timestamptz not null default now()
);
create index invoice_redactions_invoice_idx on invoice_redactions (invoice_id);

-- A guest asking their host for a copy of, or deletion of, their data, from a booking's manage link.
create table data_requests (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  email citext not null,
  kind text not null check (kind in ('access', 'erasure')),
  requested_at timestamptz not null,
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'done', 'declined')),
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  check ((status = 'open') = (resolved_at is null)),
  check (due_at > requested_at)
);
-- One open request of each kind per client per host: asking again doesn't stack up duplicates or emails.
create unique index data_requests_one_open on data_requests (host_id, email, kind) where status = 'open';
create index data_requests_host_idx on data_requests (host_id, status, due_at);
