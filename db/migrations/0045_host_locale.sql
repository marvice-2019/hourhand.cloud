-- The language of the host's own dashboard and the emails Hourhand sends the host. Separate from users.locale,
-- which is what guests see first on the host's booking pages: a Tamil-speaking coach may still teach in English.
alter table users add column host_locale text not null default 'en' check (host_locale in ('en', 'hi', 'ta'));
