-- Several named availability schedules per host. The tables already allow it (0001); this makes the rules explicit.

-- Every live host gets exactly one default schedule now, the same one their first visit would make: "Working hours",
-- weekdays 09:00-17:00 in their own zone. Hosts who already have one keep it untouched, rules and all.
with made as (
  insert into availability_schedules (user_id, name, timezone, is_default)
  select u.id, 'Working hours', u.timezone, true from users u
   where u.deleted_at is null and not exists (select 1 from availability_schedules s where s.user_id = u.id and s.is_default)
  returning id
)
insert into availability_rules (schedule_id, kind, weekday, intervals)
select made.id, 'weekly', d, '[{"from":"09:00","to":"17:00"}]'::jsonb from made cross join generate_series(1, 5) d;

-- Names tell schedules apart in the event type editor, so one host can't reuse a name (in any case).
alter table availability_schedules add constraint availability_schedules_name_length check (char_length(btrim(name)) between 1 and 60);
create unique index availability_schedules_user_name_key on availability_schedules (user_id, lower(name));

-- Deleting a schedule looks up the event types that use it.
create index if not exists event_types_schedule_id_idx on event_types (schedule_id);
