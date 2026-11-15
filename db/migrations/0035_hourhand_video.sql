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
