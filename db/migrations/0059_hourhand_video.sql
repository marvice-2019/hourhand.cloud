-- 3.11 Hourhand video: a private room per booking on the owner's own Jitsi server.

-- Allow the new location kind. Widened in place rather than re-listing every kind, so this migration and others that
-- add a kind (in whatever order they run) never drop each other's.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'event_locations'::regclass and conname = 'event_locations_kind_check';
  if def is not null and position('hourhand_video' in def) = 0 then
    alter table event_locations drop constraint event_locations_kind_check;
    -- def is "CHECK (<expr>)"; keep <expr> and add the new kind.
    execute format('alter table event_locations add constraint event_locations_kind_check check (kind = %L or %s)',
      'hourhand_video', substring(def from 7));
  end if;
end $$;

-- The room for a booking ('booking:<id>') or for every seat of a group class ('class:<class key>'). The name is random,
-- made on first join; it is never the booking id. Rooms go with the host's account.
create table video_rooms (
  room_key text primary key,
  host_id uuid not null references users(id) on delete cascade,
  room text not null unique check (room ~ '^[a-z2-7]{26}$'),
  created_at timestamptz not null default now()
);
create index on video_rooms (host_id);

-- A join link of their own for each extra guest the guest added (invitees.guests), one per booking and email. It holds
-- no manage token: it can only join the call, and only while that email is still on the booking.
create table video_guest_links (
  token text primary key check (token ~ '^[A-Za-z0-9_-]{32}$'),
  booking_id uuid not null references bookings(id) on delete cascade,
  host_id uuid not null references users(id) on delete cascade,
  email citext not null,
  created_at timestamptz not null default now(),
  unique (booking_id, email)
);
create index on video_guest_links (host_id);
