-- A host can get calendar sync alerts on WhatsApp as well as email. Off until the host saves a number and ticks it.
alter table users add column whatsapp_phone text;                       -- digits with country code, as WhatsApp sees the number
alter table users add column whatsapp_alerts boolean not null default false;
