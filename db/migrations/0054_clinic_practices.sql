-- Roadmap 3.9 (A): the Clinic plan's practice. One practice account (a therapy clinic, a coaching institute) holds
-- 3 to 10 practitioners. Each practitioner keeps their own Hourhand account: their own calendars, schedules, event
-- types, bookings and private client notes. The practice adds a shared public page, admins who manage practitioners
-- and see every booking, and (later parts) one invoice series and one payment account.
--
-- Nothing on users changes. A practice is live only while its owner's own subscription is Clinic and paid.

alter table subscriptions drop constraint subscriptions_plan_check;
alter table subscriptions add constraint subscriptions_plan_check check (plan in ('free','solo','duo','clinic'));

create table practices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references users(id) on delete cascade,  -- holds the Clinic subscription; always an admin
  slug citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),  -- hourhand.cloud/<slug>, same rules as a host's
  name text not null check (length(name) between 1 and 120),
  about text check (length(about) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person in a practice, the owner included. A person belongs to one practice at most.
create table practice_members (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references practices(id) on delete cascade,
  email citext not null unique,
  user_id uuid unique references users(id) on delete cascade,             -- set when they accept
  role text not null check (role in ('admin', 'practitioner')),
  practises boolean not null default true,  -- takes sessions: listed on the practice page and counted as a practitioner
  active boolean not null default true,     -- an admin can take a practitioner off the page without removing them
  position int not null default 0,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  check ((user_id is null) = (accepted_at is null)),
  check (role = 'admin' or practises)       -- a practitioner always practises; an admin may or may not
);
create index practice_members_practice_idx on practice_members (practice_id, position);

-- Live: the owner's own subscription is Clinic and paid (or a renewal is being retried), and the owner's account is open.
create function practice_is_live(p uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from practices x join users u on u.id = x.owner_id join subscriptions s on s.user_id = x.owner_id
    where x.id = p and u.deleted_at is null and s.plan = 'clinic' and s.status in ('active', 'past_due'))
$$;

-- Practice pages and host pages share the top-level path, so a slug is either a host's or a practice's, never both.
create function practice_slug_free() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'practices' then
    if exists (select 1 from users where slug = new.slug) then
      raise exception 'slug % is a host''s booking page', new.slug using errcode = '23505';
    end if;
  elsif exists (select 1 from practices where slug = new.slug) then
    raise exception 'slug % is a practice page', new.slug using errcode = '23505';
  end if;
  return new;
end $$;
create trigger practices_slug_free before insert or update of slug on practices for each row execute function practice_slug_free();
create trigger users_slug_free before insert or update of slug on users for each row execute function practice_slug_free();
