-- Roadmap 2.5, part 2: the client file. One page per client with their bookings, answers, money, notes and consent.
-- Additive only: note edit history, the owner's "keep versions" choice, and an index for package purchases by client.

-- Every save or clear of a private note (a client note or a session note on one booking): who and when. The text of
-- each version is kept, sealed like the note itself, only while the owner has "keep versions" on.
create table note_revisions (
  id uuid primary key,
  host_id uuid not null references users(id) on delete cascade,
  email citext,                                                       -- a client note: the client
  booking_id uuid references bookings(id) on delete cascade,          -- a session note: the booking
  actor_id uuid references users(id) on delete set null,              -- who saved it
  action text not null check (action in ('saved', 'cleared')),
  text_sealed bytea,                                                  -- the version, when "keep versions" was on
  created_at timestamptz not null default now(),
  check ((email is null) <> (booking_id is null)),
  check (action = 'saved' or text_sealed is null)
);
create index note_revisions_client_idx on note_revisions (host_id, email, created_at) where email is not null;
create index note_revisions_booking_idx on note_revisions (booking_id, created_at) where booking_id is not null;

-- The owner's choice to keep earlier versions of their notes. Off by default: only who/when is kept.
create table note_settings (
  user_id uuid primary key references users(id) on delete cascade,
  keep_versions boolean not null default false,
  updated_at timestamptz not null default now()
);

-- The client file lists a client's package purchases by email.
create index package_purchases_client_idx on package_purchases (host_id, guest_email, created_at);

-- Invoices and credit notes of the payments on one timeline page (credit notes carry the payment id too).
create index invoices_payment_idx on invoices (payment_id) where payment_id is not null;
