-- Hourhand's own staff: admins (support, read-only) and super admins (also manage staff and read the audit log).
-- A role is held by an ordinary Hourhand account and signs in the same way. Super admins named in SUPER_ADMIN_EMAILS
-- don't need a row here and can't be removed from the app, so the owner can never be locked out.
create table staff_roles (
  user_id uuid primary key references users(id) on delete cascade,
  role text not null check (role in ('admin', 'super_admin')),
  granted_by uuid references users(id) on delete set null,
  granted_at timestamptz not null default now()
);

-- Every staff action, including opening a host's account: who, what, on whom, when. Never edited or deleted by the app.
create table admin_audit (
  id bigserial primary key,
  actor_id uuid references users(id) on delete set null,
  actor_email citext not null,
  action text not null check (length(action) between 1 and 64),
  target_type text,
  target_id text,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index admin_audit_at_idx on admin_audit (at desc);
create index admin_audit_target_idx on admin_audit (target_type, target_id, at desc);
