-- A host can get calendar sync alerts on WhatsApp as well as email, to users.whatsapp_number (0001, unused until now;
-- stored as WhatsApp sees it: country code and digits). Off until the host saves a number and ticks it.
alter table users add column whatsapp_alerts boolean not null default false;
