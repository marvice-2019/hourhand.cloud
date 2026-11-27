-- Super admins approve, decline and suspend host accounts. Every existing host stays approved. A host who isn't
-- approved can still sign in, but their booking pages are hidden and take no new bookings.
alter table users
  add column review_status text not null default 'approved' check (review_status in ('pending', 'approved', 'declined', 'suspended')),
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references users(id) on delete set null;

-- Platform switches set from /admin. One today: require_host_approval ('1' = new hosts wait for a super admin).
create table platform_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
