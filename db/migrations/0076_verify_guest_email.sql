-- B11: check the guest's email before booking (docs/specs/B11-verify-guest-email.md). An event type can ask guests to enter
-- a 6-digit code emailed to them before the booking is made. Only a hash of each code is kept.
alter table event_types add column verify_guest_email boolean not null default false;

create table guest_email_codes (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references event_types(id) on delete cascade,
  email text not null,                       -- lower case
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_email_codes_lookup_idx on guest_email_codes (event_type_id, email, created_at desc);
