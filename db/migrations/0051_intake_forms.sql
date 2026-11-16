-- Intake forms (roadmap 2.5, first half): conditional questions, four new answer kinds, first-booking-only questions and
-- reusable intake templates. Additive: every existing question keeps its kind and gets defaults that change nothing
-- (no condition, asked on every booking, no number bounds, no template).

-- A host's saved question set. `questions` holds drafts in the editor's shape (conditions name an earlier question by
-- list position). Applying a template copies its questions into event types; editing it later changes nothing until
-- the host applies it again, and past bookings keep the labels they were asked with (invitees.answers copies them).
create table intake_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  questions jsonb not null default '[]' check (jsonb_typeof(questions) = 'array'),
  -- Made from one of Hourhand's starter examples and not yet saved by the host: shown with an "example" badge.
  example boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index intake_templates_user on intake_templates (user_id, created_at);

alter table custom_questions drop constraint if exists custom_questions_kind_check;
alter table custom_questions add constraint custom_questions_kind_check
  check (kind in ('short_text','long_text','phone','single_select','multi_select','consent','yes_no','date','number','email'));

alter table custom_questions
  -- Show this question only when the answer to an earlier question of the same event type is one of show_if_values.
  add column show_if_question_id uuid references custom_questions(id) on delete set null,
  add column show_if_values text[] not null default '{}',
  -- Asked only the first time a client email books with this host.
  add column first_booking_only boolean not null default false,
  -- Bounds for a number question.
  add column min_value double precision,
  add column max_value double precision,
  add column template_id uuid references intake_templates(id) on delete set null,
  add constraint custom_questions_bounds check (min_value is null or max_value is null or min_value <= max_value),
  add constraint custom_questions_show_if check (show_if_question_id is null or cardinality(show_if_values) > 0);
