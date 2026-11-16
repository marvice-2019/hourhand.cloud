-- Roadmap 3.7: guests can also book in Marathi, Bengali, Malayalam and Gujarati. Widen the check from 0022 so their
-- bookings save; existing rows already satisfy the wider list.
alter table invitees drop constraint if exists invitees_locale_check;
alter table invitees add constraint invitees_locale_check check (locale in ('en', 'hi', 'ta', 'te', 'kn', 'mr', 'bn', 'ml', 'gu'));
