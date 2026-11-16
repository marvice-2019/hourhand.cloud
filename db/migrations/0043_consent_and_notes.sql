-- Roadmap 3.10, part 1: the consent log and encrypted notes. Hosts are the data fiduciaries for their clients' data and
-- Hourhand is their processor; these give hosts the record and the protection they need. Additive only.

-- What a guest agreed to when they booked: one row per purpose per booking, with the words they were shown, the
-- version of the privacy notice in force, when and through which page. Shown on the client's record; never edited.
create table consent_records (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  booking_id uuid not null references bookings(id) on delete cascade,
  invitee_id uuid not null references invitees(id) on delete cascade,
  email citext not null,                                -- the client, as the host's client list groups them
  purpose text not null check (purpose in ('booking', 'whatsapp_updates', 'sms_updates', 'host_question')),
  granted boolean not null,
  statement text not null check (length(statement) between 1 and 2000),  -- the words on the page, in their language
  notice_version text not null check (length(notice_version) between 1 and 40),
  channel text not null check (channel in ('booking_page', 'single_use_link', 'package_link')),
  locale text not null,
  recorded_at timestamptz not null default now()
);
create index consent_records_client_idx on consent_records (host_id, email, recorded_at);
create index consent_records_booking_idx on consent_records (booking_id);

-- Client notes are now sealed (AES-256-GCM, TOKEN_ENCRYPTION_KEY) in note_sealed; `note` stays '' for sealed rows.
-- Rows written before this migration keep their plaintext until the owner next opens or saves them, which seals them.
alter table client_notes add column note_sealed bytea;

-- Session notes on one booking, sealed the same way. Only the account owner reads them.
create table booking_notes (
  booking_id uuid primary key references bookings(id) on delete cascade,
  host_id uuid not null references users(id) on delete cascade,
  note_sealed bytea not null,
  updated_at timestamptz not null default now()
);
create index booking_notes_host_idx on booking_notes (host_id);
