-- Routing forms: one short question on a shared link (/f/<token>). Each answer sends the guest to one of the host's
-- booking types, or shows them a short note instead (for example "Please email me first").
create table routing_forms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{32}$'),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  question text not null check (char_length(btrim(question)) between 1 and 200),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index routing_forms_user_id_idx on routing_forms (user_id, created_at);

create table routing_form_options (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references routing_forms(id) on delete cascade,
  position int not null check (position between 1 and 8),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  -- Deleting the booking type leaves the answer with no target; the public page then leaves it out.
  event_type_id uuid references event_types(id) on delete set null,
  message text check (message is null or char_length(btrim(message)) between 1 and 300),
  unique (form_id, position)
);
create index routing_form_options_event_type_id_idx on routing_form_options (event_type_id);
