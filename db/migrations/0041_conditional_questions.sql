-- Intake forms: a question can be shown only when an earlier question was answered a certain way.
-- {"question": "<custom_questions.id of an earlier select or consent question>", "anyOf": ["<choice>", ...]}
-- No foreign key: questions are replaced as a set on every save, and the app maps the parent by position then.
alter table custom_questions add column show_if jsonb check (show_if is null or jsonb_typeof(show_if) = 'object');
